/**
 * import-uneek-products.ts — populate `products` / `product_groups`
 * / `supplier_products` from the Uneek `/productdata/all` endpoint.
 *
 * Idempotent: every run is a CREATE-or-UPDATE. Slugs are deterministic
 * (`ProductCode` → group slug; `ShortCode` → variant slug) so re-running
 * after Uneek edits the catalogue picks up the diff without
 * duplicating rows. Nothing is deleted — products that disappeared
 * from Uneek's response are left untouched in our DB and the operator
 * decides whether to un-publish them.
 *
 * Usage (from repo root):
 *
 *   DATABASE_URL=...  npm run import:uneek-products -w @smmta/api \
 *     -- --supplier=demo-uneek --dry-run
 *
 *   # Real run, all categories, products created un-published (default):
 *   DATABASE_URL=... npm run import:uneek-products -w @smmta/api -- --supplier=demo-uneek
 *
 *   # Filter to a single category + auto-publish + cap rows for a smoke test:
 *   ... -- --supplier=demo-uneek --category=Jackets --limit=20 --publish
 *
 * Flags:
 *   --supplier=<slug>   (required) which supplier row to import for.
 *                       Resolved via `suppliers.slug`. The supplier must
 *                       have `connectorKind=UNEEK`, a non-empty
 *                       `apiBaseUrl`, and an `apiKeyEnc` envelope (set
 *                       these in the admin SPA's Drop-ship tab before
 *                       running).
 *   --category=<name>   Filter to rows whose `Category` field equals
 *                       this string (case-insensitive). Useful for a
 *                       phased import where you import jackets first
 *                       and verify before importing everything else.
 *   --limit=<n>         Process at most `n` Uneek rows (after the
 *                       category filter). Useful for first-run smoke
 *                       tests.
 *   --dry-run           Print the plan (group / variant counts +
 *                       previews) but write nothing.
 *   --publish           Mark new products + groups as `isPublished=true`.
 *                       Default: false — operator un-publishes / curates
 *                       in the admin SPA before exposing to customers.
 *   --help              Print this usage and exit.
 *
 * Field mapping (Uneek → our schema):
 *
 *   Uneek                  → our column                       notes
 *   ─────                  ─────────                           ─────
 *   ProductCode            product_groups.slug stem            family code (UX8, X3, …)
 *   ProductName            product_groups.name                 family display name
 *   ShortCode              products.stock_code                 per-variant SKU
 *   ShortCode              products.slug stem
 *   ShortCode              supplier_products.supplier_sku      so stock polling works
 *   Colour                 products.colour
 *   Hex                    products.colour_hex                 normalised via normaliseHex()
 *   Size                   products.attributes.size            JSONB axis
 *   MyPrice                supplier_products.cost_gbp          what we pay Uneek
 *   PriceSingle            products.min/max_selling_price      what customer pays
 *   Image                  products.hero_image_url
 *   FullDescription        products.long_description           may be French; trimmed
 *   ShortDescription       products.short_description
 *   Specifications         appended to long_description if set
 *   Category               product_groups.group_type           free-form string
 */

import 'dotenv/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  productGroups,
  products,
  suppliers,
  supplierProducts,
} from '../src/db/schema/index.js';
import { decrypt } from '../src/shared/crypto/encrypt.js';
import { UneekConnector } from '../src/integrations/suppliers/uneek.connector.js';
import type { UneekProductRow } from '../src/integrations/suppliers/uneek.connector.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

// ============================================================
// CLI args
// ============================================================

interface CliOpts {
  supplierSlug: string;
  category: string | null;
  limit: number | null;
  dryRun: boolean;
  publish: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  let supplierSlug = '';
  let category: string | null = null;
  let limit: number | null = null;
  let dryRun = false;
  let publish = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0);
    } else if (arg.startsWith('--supplier=')) {
      supplierSlug = arg.slice('--supplier='.length).trim();
    } else if (arg.startsWith('--category=')) {
      category = arg.slice('--category='.length).trim();
    } else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`bad --limit value: ${arg}`);
        process.exit(2);
      }
      limit = Math.floor(n);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--publish') {
      publish = true;
    } else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}`);
      printUsageAndExit(2);
    }
  }
  if (!supplierSlug) {
    console.error('--supplier=<slug> is required');
    printUsageAndExit(2);
  }
  return { supplierSlug, category, limit, dryRun, publish };
}

function printUsageAndExit(code: number): never {
  console.log(`
Usage:
  npm run import:uneek-products -w @smmta/api -- --supplier=<slug> [flags]

Flags:
  --supplier=<slug>   (required) suppliers.slug to import for; must be UNEEK kind
  --category=<name>   filter Uneek rows by Category (case-insensitive)
  --limit=<n>         cap row count (after category filter)
  --dry-run           print plan, write nothing
  --publish           mark new products/groups as published (default: false)
  --help              this message
`.trim());
  process.exit(code);
}

// ============================================================
// Helpers
// ============================================================

/** URL-safe slug: lowercase, ASCII letters/digits/dashes only.
 *  Multiple dashes collapse to one; leading/trailing dashes stripped.
 *  Empty input → 'item'. */
export function slugify(input: string): string {
  const cleaned = (input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'item';
}

/**
 * Normalise the Uneek `Hex` field to a canonical `#RRGGBB` string, or
 * null if no usable value.
 *
 * Uneek's catalogue is messy: most rows have a real hex like `#A6A6A6`,
 * but plenty have literal colour names like `WHITE`, `NAVY`, `BLACK`.
 * We pre-translate the known literal-name set to a sensible hex; anything
 * we don't recognise becomes null and the operator can fill it in later
 * via the admin SPA.
 */
export function normaliseHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  // Already a hex code?
  const hexRe = /^#?([0-9a-fA-F]{6})$/;
  const m = hexRe.exec(t);
  if (m) return `#${m[1]!.toUpperCase()}`;
  // Map known literal colour names.
  const key = t.toUpperCase().replace(/[^A-Z]/g, '');
  const named: Record<string, string> = {
    WHITE: '#FFFFFF',
    BLACK: '#000000',
    NAVY: '#1F2A44',
    NAVYBLUE: '#1F2A44',
    ROYAL: '#1F3F8B',
    ROYALBLUE: '#1F3F8B',
    RED: '#C8102E',
    BURGUNDY: '#6E1F2E',
    BOTTLE: '#1F4D3F',
    BOTTLEGREEN: '#1F4D3F',
    GREEN: '#1F7A1F',
    KELLY: '#1F7A3D',
    KELLYGREEN: '#1F7A3D',
    EMERALD: '#1F8B5F',
    LIME: '#A6CE39',
    YELLOW: '#FFD32A',
    GOLD: '#D4AF37',
    ORANGE: '#F26B1F',
    PURPLE: '#5D2E8C',
    PINK: '#F4A1B5',
    HOTPINK: '#E5398A',
    GREY: '#7A7A7A',
    GRAY: '#7A7A7A',
    HEATHERGREY: '#A6A6A6',
    HEATHERGRAY: '#A6A6A6',
    CHARCOAL: '#36454F',
    BROWN: '#5C3A21',
    BEIGE: '#D8C3A5',
    CREAM: '#F5EFE0',
    NATURAL: '#E8DCC2',
    SAND: '#D8B98E',
    KHAKI: '#8B7E55',
    MAROON: '#6E1F2E',
    TAN: '#C19A6B',
    SILVER: '#BFBFBF',
    TURQUOISE: '#2EB1B1',
    TEAL: '#1F7A8C',
    SKY: '#7EC4DD',
    SKYBLUE: '#7EC4DD',
    LIGHTBLUE: '#A8C8E0',
    DARKBLUE: '#1F2A44',
    LIGHTGREY: '#C8C8C8',
    DARKGREY: '#4A4A4A',
  };
  return named[key] ?? null;
}

/** Coerce Uneek's number-or-string price into a 2dp decimal string, or
 *  null if missing/unparseable. */
function priceToDecimalString(raw: number | string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

/** Pre-categorise variants into family buckets keyed by `ProductCode`.
 *  Rows missing `ProductCode` or `ShortCode` are dropped (and logged
 *  later by the caller). */
export function bucketByFamily(rows: UneekProductRow[]): Map<string, UneekProductRow[]> {
  const out = new Map<string, UneekProductRow[]>();
  for (const r of rows) {
    if (!r.ProductCode || !r.ShortCode) continue;
    const arr = out.get(r.ProductCode) ?? [];
    arr.push(r);
    out.set(r.ProductCode, arr);
  }
  return out;
}

// ============================================================
// Import result type
// ============================================================

export interface ImportSummary {
  fetched: number;
  skippedNoShortCode: number;
  filteredOut: number;
  families: number;
  variantsConsidered: number;
  groupsCreated: number;
  groupsUpdated: number;
  productsCreated: number;
  productsUpdated: number;
  supplierProductsCreated: number;
  supplierProductsUpdated: number;
  dryRun: boolean;
}

// ============================================================
// Main importer (exported so tests can drive it)
// ============================================================

interface ImportInput {
  /** Pre-fetched catalogue rows (allows tests to bypass HTTP). */
  rows: UneekProductRow[];
  /** Supplier UUID for FK on `supplier_products`. */
  supplierId: string;
  /** Singleton company id for the `companyId` column on each table. */
  companyId: string;
  /** CLI options. */
  category: string | null;
  limit: number | null;
  dryRun: boolean;
  publish: boolean;
}

export async function importUneekProducts(input: ImportInput): Promise<ImportSummary> {
  const db = getDb();
  const summary: ImportSummary = {
    fetched: input.rows.length,
    skippedNoShortCode: 0,
    filteredOut: 0,
    families: 0,
    variantsConsidered: 0,
    groupsCreated: 0,
    groupsUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    supplierProductsCreated: 0,
    supplierProductsUpdated: 0,
    dryRun: input.dryRun,
  };

  // Filter ------------------------------------------------------------
  const wantedCategory = input.category?.trim().toLowerCase() ?? null;
  let working: UneekProductRow[] = [];
  for (const r of input.rows) {
    if (!r.ShortCode || !r.ProductCode) {
      summary.skippedNoShortCode++;
      continue;
    }
    if (wantedCategory) {
      const cat = (r.Category ?? '').trim().toLowerCase();
      if (cat !== wantedCategory) {
        summary.filteredOut++;
        continue;
      }
    }
    working.push(r);
  }
  if (input.limit !== null && working.length > input.limit) {
    summary.filteredOut += working.length - input.limit;
    working = working.slice(0, input.limit);
  }
  summary.variantsConsidered = working.length;

  const byFamily = bucketByFamily(working);
  summary.families = byFamily.size;

  // Plan -------------------------------------------------------------
  // We compute the writes up front so --dry-run can print them
  // cleanly without partially mutating state.
  type GroupPlan = {
    slug: string;
    name: string;
    groupType: string | null;
    longDescription: string | null;
    shortDescription: string | null;
    heroImageUrl: string | null;
  };
  const groupPlans: GroupPlan[] = [];
  const familyToSlug = new Map<string, string>();
  for (const [familyCode, rows] of byFamily) {
    const slug = slugify(familyCode);
    familyToSlug.set(familyCode, slug);
    const first = rows[0]!;
    const longBits: string[] = [];
    if (first.FullDescription?.trim()) longBits.push(first.FullDescription.trim());
    if (first.Specifications?.trim()) longBits.push(`### Specifications\n\n${first.Specifications.trim()}`);
    const long = longBits.length > 0 ? longBits.join('\n\n') : null;
    const short = first.ShortDescription?.trim() || null;
    // Pick the first variant with a real image as the family hero.
    const heroImageUrl = rows.find((r) => r.Image?.trim())?.Image?.trim() || null;
    groupPlans.push({
      slug,
      name: (first.ProductName ?? familyCode).trim().slice(0, 200),
      groupType: first.Category?.trim() || null,
      longDescription: long,
      shortDescription: short ? short.slice(0, 280) : null,
      heroImageUrl,
    });
  }

  type VariantPlan = {
    familyCode: string;
    groupSlug: string;
    variantSlug: string;
    stockCode: string;
    name: string;
    colour: string | null;
    colourHex: string | null;
    size: string | null;
    heroImageUrl: string | null;
    longDescription: string | null;
    shortDescription: string | null;
    sellingPrice: string | null;
    costPrice: string | null;
    attributes: Record<string, string>;
  };
  const variantPlans: VariantPlan[] = [];
  for (const r of working) {
    const familyCode = r.ProductCode!;
    const groupSlug = familyToSlug.get(familyCode)!;
    const shortCode = r.ShortCode!.trim();
    const variantSlug = slugify(shortCode);
    const attrs: Record<string, string> = {};
    if (r.Size?.trim()) attrs.size = r.Size.trim();
    if (r.Colour?.trim()) attrs.colour = r.Colour.trim();
    const longBits: string[] = [];
    if (r.FullDescription?.trim()) longBits.push(r.FullDescription.trim());
    if (r.Specifications?.trim()) longBits.push(`### Specifications\n\n${r.Specifications.trim()}`);
    variantPlans.push({
      familyCode,
      groupSlug,
      variantSlug,
      stockCode: shortCode,
      name: [r.ProductName ?? familyCode, r.Colour, r.Size]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join(' · ')
        .slice(0, 500),
      colour: r.Colour?.trim() || null,
      colourHex: normaliseHex(r.Hex),
      size: r.Size?.trim() || null,
      heroImageUrl: r.Image?.trim() || r.SMColourImage?.trim() || null,
      longDescription: longBits.length > 0 ? longBits.join('\n\n') : null,
      shortDescription: r.ShortDescription?.trim().slice(0, 280) || null,
      sellingPrice: priceToDecimalString(r.PriceSingle),
      costPrice: priceToDecimalString(r.MyPrice),
      attributes: attrs,
    });
  }

  // Dry-run: print the plan and return ---------------------------------
  if (input.dryRun) {
    console.log('');
    console.log('=== DRY RUN — no DB writes ===');
    console.log(`Fetched ${summary.fetched} rows from Uneek.`);
    console.log(`Skipped ${summary.skippedNoShortCode} for missing ShortCode/ProductCode.`);
    console.log(`Filtered out ${summary.filteredOut} by --category / --limit.`);
    console.log(`Would touch ${summary.families} families / ${summary.variantsConsidered} variants.`);
    console.log('');
    console.log('First 5 families that would be inserted/updated:');
    for (const g of groupPlans.slice(0, 5)) {
      console.log(`  - ${g.slug.padEnd(20)} "${g.name}"  [${g.groupType ?? 'no category'}]`);
    }
    console.log('');
    console.log('First 5 variants:');
    for (const v of variantPlans.slice(0, 5)) {
      const price = v.sellingPrice ? `£${v.sellingPrice}` : '£?';
      const cost = v.costPrice ? `cost £${v.costPrice}` : 'cost £?';
      console.log(
        `  - ${v.stockCode.padEnd(12)} ${v.colour ?? '—'} / ${v.size ?? '—'}  ${price} (${cost})`,
      );
    }
    return summary;
  }

  // Apply --------------------------------------------------------------
  // We do groups first (so variants can FK to them), then variants, then
  // supplier_products. Each step is a small batch upsert.
  return db.transaction(async (tx) => {
    // 1. Groups
    const existingGroups = await tx
      .select({ id: productGroups.id, slug: productGroups.slug })
      .from(productGroups)
      .where(
        and(
          eq(productGroups.companyId, input.companyId),
          inArray(productGroups.slug, groupPlans.map((g) => g.slug)),
        ),
      );
    const groupSlugToId = new Map<string, string>();
    for (const g of existingGroups) {
      if (g.slug) groupSlugToId.set(g.slug, g.id);
    }
    for (const gp of groupPlans) {
      const existingId = groupSlugToId.get(gp.slug);
      if (existingId) {
        await tx
          .update(productGroups)
          .set({
            name: gp.name,
            groupType: gp.groupType,
            longDescription: gp.longDescription,
            shortDescription: gp.shortDescription,
            heroImageUrl: gp.heroImageUrl,
            // Only flip isPublished when the operator opted in. Don't
            // un-publish on subsequent runs without --publish — the
            // operator may have curated visibility manually.
            ...(input.publish ? { isPublished: true } : {}),
            attributeAxes: ['size', 'colour'],
            updatedAt: new Date(),
          })
          .where(eq(productGroups.id, existingId));
        summary.groupsUpdated++;
      } else {
        const [inserted] = await tx
          .insert(productGroups)
          .values({
            companyId: input.companyId,
            name: gp.name,
            groupType: gp.groupType,
            slug: gp.slug,
            shortDescription: gp.shortDescription,
            longDescription: gp.longDescription,
            heroImageUrl: gp.heroImageUrl,
            galleryImageUrls: [],
            isPublished: input.publish,
            sortOrder: 0,
            attributeAxes: ['size', 'colour'],
          })
          .returning({ id: productGroups.id, slug: productGroups.slug });
        if (!inserted) throw new Error(`Failed to insert group ${gp.slug}`);
        groupSlugToId.set(gp.slug, inserted.id);
        summary.groupsCreated++;
      }
    }

    // 2. Variants
    const existingProducts = await tx
      .select({ id: products.id, slug: products.slug })
      .from(products)
      .where(
        and(
          eq(products.companyId, input.companyId),
          inArray(products.slug, variantPlans.map((v) => v.variantSlug)),
        ),
      );
    const productSlugToId = new Map<string, string>();
    for (const p of existingProducts) {
      if (p.slug) productSlugToId.set(p.slug, p.id);
    }
    for (const vp of variantPlans) {
      const groupId = groupSlugToId.get(vp.groupSlug);
      if (!groupId) throw new Error(`Internal: missing group ${vp.groupSlug} for variant ${vp.stockCode}`);
      const existingId = productSlugToId.get(vp.variantSlug);
      if (existingId) {
        await tx
          .update(products)
          .set({
            name: vp.name,
            stockCode: vp.stockCode,
            groupId,
            colour: vp.colour,
            colourHex: vp.colourHex,
            heroImageUrl: vp.heroImageUrl,
            longDescription: vp.longDescription,
            shortDescription: vp.shortDescription,
            minSellingPrice: vp.sellingPrice ?? undefined,
            maxSellingPrice: vp.sellingPrice ?? undefined,
            expectedNextCost: vp.costPrice ?? undefined,
            attributes: vp.attributes,
            ...(input.publish ? { isPublished: true } : {}),
            updatedAt: new Date(),
          })
          .where(eq(products.id, existingId));
        summary.productsUpdated++;
      } else {
        const [inserted] = await tx
          .insert(products)
          .values({
            companyId: input.companyId,
            name: vp.name,
            stockCode: vp.stockCode,
            description: vp.shortDescription,
            expectedNextCost: vp.costPrice ?? '0',
            minSellingPrice: vp.sellingPrice ?? undefined,
            maxSellingPrice: vp.sellingPrice ?? undefined,
            productType: 'PHYSICAL' as const,
            groupId,
            colour: vp.colour,
            colourHex: vp.colourHex,
            slug: vp.variantSlug,
            shortDescription: vp.shortDescription,
            longDescription: vp.longDescription,
            heroImageUrl: vp.heroImageUrl,
            galleryImageUrls: vp.heroImageUrl ? [vp.heroImageUrl] : [],
            isPublished: input.publish,
            sortOrderInGroup: 0,
            attributes: vp.attributes,
            supplierId: input.supplierId,
          })
          .returning({ id: products.id, slug: products.slug });
        if (!inserted) throw new Error(`Failed to insert variant ${vp.variantSlug}`);
        productSlugToId.set(vp.variantSlug, inserted.id);
        summary.productsCreated++;
      }
    }

    // 3. supplier_products mapping (so the polling worker can fetch live stock)
    //    Unique key is (productId, supplierId); we upsert by SKU.
    const variantProductIds = variantPlans
      .map((vp) => productSlugToId.get(vp.variantSlug))
      .filter((id): id is string => Boolean(id));
    const existingSP = variantProductIds.length === 0 ? [] : await tx
      .select({ id: supplierProducts.id, productId: supplierProducts.productId })
      .from(supplierProducts)
      .where(
        and(
          eq(supplierProducts.companyId, input.companyId),
          eq(supplierProducts.supplierId, input.supplierId),
          inArray(supplierProducts.productId, variantProductIds),
        ),
      );
    const productIdToSPId = new Map<string, string>();
    for (const sp of existingSP) productIdToSPId.set(sp.productId, sp.id);

    for (const vp of variantPlans) {
      const productId = productSlugToId.get(vp.variantSlug);
      if (!productId) continue;
      const cost = vp.costPrice ?? '0.00';
      const existingSpId = productIdToSPId.get(productId);
      if (existingSpId) {
        await tx
          .update(supplierProducts)
          .set({
            supplierSku: vp.stockCode,
            costGbp: cost,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(supplierProducts.id, existingSpId));
        summary.supplierProductsUpdated++;
      } else {
        await tx
          .insert(supplierProducts)
          .values({
            companyId: input.companyId,
            productId,
            supplierId: input.supplierId,
            supplierSku: vp.stockCode,
            costGbp: cost,
            isActive: true,
            priority: 100,
          });
        summary.supplierProductsCreated++;
      }
    }

    return summary;
  });
}

// ============================================================
// CLI entry point
// ============================================================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const companyId = getSingletonCompanyId();
  const db = getDb();

  const supplier = await db.query.suppliers.findFirst({
    where: and(eq(suppliers.slug, opts.supplierSlug), isNull(suppliers.deletedAt)),
  });
  if (!supplier) {
    throw new Error(`No supplier found with slug=${opts.supplierSlug}. Create one in the admin SPA first.`);
  }
  if (supplier.connectorKind !== 'UNEEK') {
    throw new Error(`Supplier ${opts.supplierSlug} has connectorKind=${supplier.connectorKind}, expected UNEEK.`);
  }
  if (!supplier.apiBaseUrl || !supplier.apiKeyEnc) {
    throw new Error(
      `Supplier ${opts.supplierSlug} is missing apiBaseUrl or apiKeyEnc — set these in the admin SPA's Drop-ship tab.`,
    );
  }

  const apiKey = decrypt(supplier.apiKeyEnc);
  const connector = new UneekConnector({
    apiKey,
    apiBaseUrl: supplier.apiBaseUrl,
    apiAuthScheme: supplier.apiAuthScheme,
    timeoutMs: 60_000,
  });

  console.log(`[import:uneek] fetching catalogue from ${supplier.apiBaseUrl} …`);
  const rows = await connector.getProductCatalogue();
  console.log(`[import:uneek] fetched ${rows.length} catalogue rows.`);

  const summary = await importUneekProducts({
    rows,
    supplierId: supplier.id,
    companyId,
    category: opts.category,
    limit: opts.limit,
    dryRun: opts.dryRun,
    publish: opts.publish,
  });

  console.log('');
  console.log('[import:uneek] summary:');
  console.log(`  fetched                     : ${summary.fetched}`);
  console.log(`  skipped (no ShortCode)      : ${summary.skippedNoShortCode}`);
  console.log(`  filtered out                : ${summary.filteredOut}`);
  console.log(`  families touched            : ${summary.families}`);
  console.log(`  variants considered         : ${summary.variantsConsidered}`);
  if (!summary.dryRun) {
    console.log(`  groups   created / updated  : ${summary.groupsCreated} / ${summary.groupsUpdated}`);
    console.log(`  products created / updated  : ${summary.productsCreated} / ${summary.productsUpdated}`);
    console.log(`  supplier_products c / u     : ${summary.supplierProductsCreated} / ${summary.supplierProductsUpdated}`);
  }
  console.log(summary.dryRun ? '\n[import:uneek] dry-run complete.' : '\n[import:uneek] OK.');
}

const isCliEntry = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/').split('/').pop() ?? '');
  } catch {
    return false;
  }
})();

if (isCliEntry || process.argv[1]?.endsWith('import-uneek-products.ts')) {
  main()
    .catch((err) => {
      console.error('[import:uneek] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabase();
    });
}
