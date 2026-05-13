/**
 * Bulk Ralawise catalogue importer.
 *
 * Reads `CustomerDataFull.csv` (~204 MB, 103k rows) from Ralawise's
 * Marketing Hub and upserts into our schema:
 *
 *   - one `product_groups` row per Style Code (~4360 rows)
 *   - one `products` row per CSV row (one per SKU)
 *   - one `supplier_products` row per `products` row (the Ralawise
 *     supplier mapping; the polling worker keeps stock fresh)
 *   - one `product_channels` row per `products` row when `--channel`
 *     is passed (defaults to clothes-shop)
 *
 * Streaming + batched: we never load the whole file into memory.
 * `csv-parse` emits row-by-row; we buffer rows by Style Code and
 * flush a transaction every ~`BATCH_SIZE` rows (or at EOF).
 *
 * Idempotent: re-running upserts by deterministic slugs and natural
 * keys. Admin-edited fields are protected — see RALAWISE_IMPORT_NOTES.md
 * for the full refresh / protect matrix.
 *
 * Usage:
 *
 *   DATABASE_URL=postgresql://...                                \
 *   RALAWISE_CSV_PATH=~/.tmp.Ralawise/CustomerDataFull.csv       \
 *   RALAWISE_DEFAULT_MARKUP=2.0                                  \
 *   npm run seed:ralawise-catalogue -w @smmta/api -- [flags]
 *
 * Flags:
 *   --limit=<n>         Process at most <n> rows (post-status filter).
 *                       Useful for dev smoke runs.
 *   --dry-run           Parse + validate but write nothing.
 *   --markup=<x.y>      Override the env var. Default 2.0.
 *   --channel=<slug>    Channel to attach products to via
 *                       product_channels. Default: 'clothes-shop'.
 *                       Pass empty string to skip channel rows.
 *   --publish           Mark new products + groups as is_published=true.
 *                       Default false — operator curates before exposing.
 *   --help              Print usage and exit.
 *
 * Performance target: <30 min for the full 103k rows on a modern VPS.
 * Strategies: streaming parse, batched transactions, single writer
 * (no parallel fan-out), Drizzle's `onConflictDoUpdate` for upserts.
 */
import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as csvParse } from 'csv-parse';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  channels,
  productChannels,
  productGroups,
  products,
  suppliers,
  supplierProducts,
} from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

// ============================================================
// CLI
// ============================================================

interface CliOpts {
  csvPath: string;
  markup: number;
  channelSlug: string | null;
  limit: number | null;
  dryRun: boolean;
  publish: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const flags = new Map<string, string | true>();
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0);
    } else if (arg === '--dry-run') {
      flags.set('dry-run', true);
    } else if (arg === '--publish') {
      flags.set('publish', true);
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) {
        console.error(`unknown flag: ${arg}`);
        printUsageAndExit(2);
      }
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      console.error(`unexpected positional arg: ${arg}`);
      printUsageAndExit(2);
    }
  }

  // Resolve the CSV path. Operator passes --csv-path or sets the env
  // var; default to ~/.tmp.Ralawise/CustomerDataFull.csv (mirrors the
  // VPS layout per the brief).
  const csvFromFlag = typeof flags.get('csv-path') === 'string' ? (flags.get('csv-path') as string) : null;
  const csvFromEnv = process.env.RALAWISE_CSV_PATH?.trim() ?? null;
  const csvDefault = path.join(os.homedir(), '.tmp.Ralawise', 'CustomerDataFull.csv');
  const csvPath = csvFromFlag ?? csvFromEnv ?? csvDefault;

  // Markup: --markup flag wins; env second; 2.0 default.
  const markupFromFlag = typeof flags.get('markup') === 'string' ? Number(flags.get('markup')) : NaN;
  const markupFromEnv = process.env.RALAWISE_DEFAULT_MARKUP ? Number(process.env.RALAWISE_DEFAULT_MARKUP) : NaN;
  const markup =
    Number.isFinite(markupFromFlag) && markupFromFlag > 0
      ? markupFromFlag
      : Number.isFinite(markupFromEnv) && markupFromEnv > 0
        ? markupFromEnv
        : 2.0;

  const limitRaw = flags.get('limit');
  let limit: number | null = null;
  if (typeof limitRaw === 'string') {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`bad --limit value: ${limitRaw}`);
      printUsageAndExit(2);
    }
    limit = Math.floor(n);
  }

  // --channel='' means "skip channel rows". --channel not passed
  // means "default to clothes-shop".
  let channelSlug: string | null = 'clothes-shop';
  if (flags.has('channel')) {
    const v = flags.get('channel');
    channelSlug = typeof v === 'string' && v.length > 0 ? v : null;
  }

  return {
    csvPath,
    markup,
    channelSlug,
    limit,
    dryRun: flags.has('dry-run'),
    publish: flags.has('publish'),
  };
}

function printUsageAndExit(code: number): never {
  console.log(`
Usage:
  npm run seed:ralawise-catalogue -w @smmta/api -- [flags]

Flags:
  --csv-path=<path>     Path to CustomerDataFull.csv (or set RALAWISE_CSV_PATH).
                        Default: ~/.tmp.Ralawise/CustomerDataFull.csv
  --markup=<x.y>        Retail-price = cost × markup. Default 2.0 (or RALAWISE_DEFAULT_MARKUP).
  --channel=<slug>      Pin products to this channel via product_channels.
                        Default: 'clothes-shop'. Pass --channel= (empty) to skip.
  --limit=<n>           Process at most <n> rows (post Live filter). For smoke tests.
  --dry-run             Parse + validate, write nothing.
  --publish             Mark new products + groups as is_published=true.
  --help                This message.
`.trim());
  process.exit(code);
}

// ============================================================
// Helpers
// ============================================================

/** URL-safe slug: lowercase, ASCII letters/digits/dashes only. */
export function slugify(input: string): string {
  const cleaned = (input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'item';
}

/** Parse a decimal price like "21.25" → 21.25. Strips currency
 *  symbols, commas, whitespace. Returns null on unparseable input. */
export function parseDecimal(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[£$€,\s]/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Apply markup + round to 2 decimals. Returns null when cost is null. */
export function applyMarkup(cost: number | null, markup: number): string | null {
  if (cost === null || !Number.isFinite(cost) || cost <= 0) return null;
  if (!Number.isFinite(markup) || markup <= 0) return null;
  const retail = Math.round(cost * markup * 100) / 100;
  return retail.toFixed(2);
}

/** Parse a date like "2026-12-31 00:00:00" → Date, or null. */
export function parseLicenceExpiry(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  // ISO-ish, but with a space separator. Date.parse accepts both with
  // a 'T' or a space on most engines, but be explicit.
  const iso = t.includes('T') ? t : t.replace(' ', 'T');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Convert "51 51 51" RGB triple to "#RRGGBB", or null if unparseable. */
export function rgbToHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = String(raw).trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return '#' + nums.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Take the FIRST segment of a pipe-separated taxonomy path. */
export function topLevelCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  return t.split('|')[0]!.trim() || null;
}

/** Pick a hero image URL — colour image first (variant-specific),
 *  fall back to primary product image. Returns null if neither. */
export function pickHeroImage(row: RalawiseRawRow): string | null {
  const colour = row['Colour Image']?.trim();
  if (colour) return colour;
  const primary = row['Primary Product Image URL']?.trim();
  if (primary) return primary;
  return null;
}

// ============================================================
// CSV → typed row
// ============================================================

/** The raw CSV row shape (61 columns). All values are strings; we
 *  parse / coerce in `normaliseRow`. */
export interface RalawiseRawRow {
  [key: string]: string;
}

export interface RalawiseNormalisedRow {
  /** SKU Code from column 1 — the variant SKU. Our supplierSku. */
  skuCode: string;
  /** Style Code from column 3 — the family / product_group natural key. */
  styleCode: string;
  styleName: string;
  colourCode: string;
  colourName: string;
  sizeCode: string;
  sizeName: string;
  specification: string;
  retailDescription: string;
  productType: string;
  gender: string;
  fabric: string;
  weightGsm: string;
  /** Resolved colour-image-url or primary-product-image-url, or null. */
  heroImageUrl: string | null;
  /** Always the primary product image (used as the group hero). */
  groupHeroImageUrl: string | null;
  /** From the RGB column → "#RRGGBB" or null. */
  colourHex: string | null;
  /** Top-level category from the pipe-separated taxonomy, or null. */
  category: string | null;
  /** What we pay Ralawise per unit. Comes from `Single Price` (col 46). */
  costGbp: number | null;
  /** Customer-facing retail = cost * markup, as a 2dp string. */
  retailGbp: string | null;
  /** Image-licence expiry as a Date, or null. */
  imageLicenceExpiresAt: Date | null;
  /** Status from column 50. We only keep 'Live' rows. */
  skuStatus: string;
}

export function normaliseRow(row: RalawiseRawRow, markup: number): RalawiseNormalisedRow {
  const cost = parseDecimal(row['Single Price']);
  return {
    skuCode: (row['Sku Code'] ?? '').trim(),
    styleCode: (row['Style Code'] ?? '').trim(),
    styleName: (row['Style Name'] ?? '').trim(),
    colourCode: (row['Colour Code'] ?? '').trim(),
    colourName: (row['Colour Name'] ?? '').trim(),
    sizeCode: (row['Size Code'] ?? '').trim(),
    sizeName: (row['Size Name'] ?? '').trim(),
    specification: (row['Specification'] ?? '').trim(),
    retailDescription: (row['Retail Description'] ?? '').trim(),
    productType: (row['Product Type'] ?? '').trim(),
    gender: (row['Gender'] ?? '').trim(),
    fabric: (row['Fabric'] ?? '').trim(),
    weightGsm: (row['Weight (GSM)'] ?? '').trim(),
    heroImageUrl: pickHeroImage(row),
    groupHeroImageUrl: row['Primary Product Image URL']?.trim() || null,
    colourHex: rgbToHex(row['RGB']),
    category: topLevelCategory(row['Categorisation']),
    costGbp: cost,
    retailGbp: applyMarkup(cost, markup),
    imageLicenceExpiresAt: parseLicenceExpiry(row['Primary Image Licence Expiry Date']),
    skuStatus: (row['Sku Status'] ?? '').trim(),
  };
}

// ============================================================
// Import summary type
// ============================================================

export interface ImportSummary {
  rowsRead: number;
  rowsSkippedDiscontinued: number;
  rowsSkippedMalformed: number;
  rowsConsidered: number;
  groupsCreated: number;
  groupsUpdated: number;
  productsCreated: number;
  productsUpdated: number;
  supplierProductsCreated: number;
  supplierProductsUpdated: number;
  productChannelsCreated: number;
  productChannelsUpdated: number;
  dryRun: boolean;
  malformedExamples: Array<{ rowIndex: number; reason: string }>;
}

// ============================================================
// Importer — operates on a stream of typed rows
// ============================================================

const BATCH_SIZE = 1000;

interface ImportContext {
  companyId: string;
  supplierId: string;
  channelId: string | null;
  publish: boolean;
  dryRun: boolean;
}

/**
 * Streaming-friendly importer. Takes an async iterable of raw CSV
 * rows (so tests can drive it from a Node Readable / a hand-built
 * array, and the CLI drives it from `csv-parse` on a real file).
 *
 * Buffers rows by style code so each transaction sees complete style
 * groups (the upsert of product_groups happens together with the
 * upsert of their products).
 */
export async function runImport(
  rowsAsyncIter: AsyncIterable<RalawiseRawRow>,
  ctx: ImportContext,
  opts: { limit: number | null; markup: number; onProgress?: (s: ImportSummary) => void },
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    rowsRead: 0,
    rowsSkippedDiscontinued: 0,
    rowsSkippedMalformed: 0,
    rowsConsidered: 0,
    groupsCreated: 0,
    groupsUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    supplierProductsCreated: 0,
    supplierProductsUpdated: 0,
    productChannelsCreated: 0,
    productChannelsUpdated: 0,
    dryRun: ctx.dryRun,
    malformedExamples: [],
  };

  let batch: RalawiseNormalisedRow[] = [];
  // We flush at BATCH_SIZE rows OR on style-code change to ensure
  // each transaction sees full style groups. Track the current style.
  let currentStyle = '';

  const flush = async () => {
    if (batch.length === 0) return;
    if (!ctx.dryRun) {
      await applyBatch(batch, ctx, summary);
    }
    batch = [];
  };

  let rowIndex = 0;
  for await (const rawRow of rowsAsyncIter) {
    rowIndex++;
    summary.rowsRead++;
    let row: RalawiseNormalisedRow;
    try {
      row = normaliseRow(rawRow, opts.markup);
    } catch (err) {
      summary.rowsSkippedMalformed++;
      if (summary.malformedExamples.length < 10) {
        summary.malformedExamples.push({ rowIndex, reason: err instanceof Error ? err.message : 'parse error' });
      }
      continue;
    }
    // Order matters: a row with no SKU is malformed (e.g. trailing
    // empty CSV row), not "discontinued" (which means the SKU exists
    // but Ralawise has marked it dead). Check structural shape first,
    // then catalogue status.
    if (!row.skuCode || !row.styleCode) {
      summary.rowsSkippedMalformed++;
      if (summary.malformedExamples.length < 10) {
        summary.malformedExamples.push({ rowIndex, reason: 'missing SKU or Style Code' });
      }
      continue;
    }
    if (row.skuStatus !== 'Live') {
      summary.rowsSkippedDiscontinued++;
      continue;
    }
    summary.rowsConsidered++;
    if (opts.limit !== null && summary.rowsConsidered > opts.limit) {
      summary.rowsConsidered--; // we won't process this one
      break;
    }

    // Flush when style changes AND batch is getting large; otherwise
    // wait until we have a full batch. This balances "complete style
    // group per transaction" against "fixed-size batches".
    if (
      batch.length >= BATCH_SIZE &&
      row.styleCode !== currentStyle &&
      currentStyle !== ''
    ) {
      await flush();
      opts.onProgress?.(summary);
    }
    currentStyle = row.styleCode;
    batch.push(row);
  }
  await flush();
  return summary;
}

/** Group rows by style code (preserving insertion order) — every
 *  flush in `runImport` calls this on the batch. */
function groupByStyle(rows: RalawiseNormalisedRow[]): Map<string, RalawiseNormalisedRow[]> {
  const out = new Map<string, RalawiseNormalisedRow[]>();
  for (const r of rows) {
    const arr = out.get(r.styleCode);
    if (arr) arr.push(r);
    else out.set(r.styleCode, [r]);
  }
  return out;
}

/**
 * Upsert one batch into the DB. Each batch is one transaction.
 *
 * Refresh strategy on re-import:
 *   - product_groups: name, description (from spec), hero image URL,
 *     group_type (category), attribute_axes are refreshed every run.
 *     `is_published` is only set when --publish.
 *   - products: name, description, colour, colourHex, hero image URL,
 *     image_licence_expires_at, attributes are refreshed. The retail
 *     price (min/maxSellingPrice) is refreshed too so a markup change
 *     propagates. `is_published` only set when --publish.
 *   - supplier_products: cost_gbp + supplier_sku refreshed; isActive
 *     stays as-is.
 *   - product_channels: row created if missing with isOffered=true,
 *     priceOverrideGbp left null so the base products.minSellingPrice
 *     drives the displayed price. Existing rows are NOT updated —
 *     admin-side priceOverrideGbp edits stay sacred.
 */
async function applyBatch(
  rows: RalawiseNormalisedRow[],
  ctx: ImportContext,
  summary: ImportSummary,
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const styleBuckets = groupByStyle(rows);

  await db.transaction(async (tx) => {
    // ── 1. product_groups (one row per style code) ────────────────
    const styleSlugs = new Map<string, string>();
    for (const styleCode of styleBuckets.keys()) {
      styleSlugs.set(styleCode, `ralawise-${slugify(styleCode)}`);
    }

    const groupSlugList = [...styleSlugs.values()];
    const existingGroups = await tx
      .select({ id: productGroups.id, slug: productGroups.slug })
      .from(productGroups)
      .where(
        and(
          eq(productGroups.companyId, ctx.companyId),
          inArray(productGroups.slug, groupSlugList),
        ),
      );
    const groupSlugToId = new Map<string, string>();
    for (const g of existingGroups) {
      if (g.slug) groupSlugToId.set(g.slug, g.id);
    }

    for (const [styleCode, styleRows] of styleBuckets) {
      const slug = styleSlugs.get(styleCode)!;
      const first = styleRows[0]!;
      const longDescBits: string[] = [];
      if (first.retailDescription) longDescBits.push(first.retailDescription);
      if (first.specification) longDescBits.push(`### Specifications\n\n${first.specification}`);
      const longDescription = longDescBits.length > 0 ? longDescBits.join('\n\n') : null;
      const shortDescription = first.retailDescription
        ? first.retailDescription.slice(0, 280)
        : null;
      const existingId = groupSlugToId.get(slug);
      if (existingId) {
        await tx
          .update(productGroups)
          .set({
            name: first.styleName.slice(0, 200),
            description: shortDescription,
            longDescription,
            shortDescription,
            heroImageUrl: first.groupHeroImageUrl,
            groupType: first.category,
            attributeAxes: ['size', 'colour'],
            ...(ctx.publish ? { isPublished: true } : {}),
            updatedAt: new Date(),
          })
          .where(eq(productGroups.id, existingId));
        summary.groupsUpdated++;
      } else {
        const [inserted] = await tx
          .insert(productGroups)
          .values({
            companyId: ctx.companyId,
            name: first.styleName.slice(0, 200),
            description: shortDescription,
            groupType: first.category,
            slug,
            shortDescription,
            longDescription,
            heroImageUrl: first.groupHeroImageUrl,
            galleryImageUrls: [],
            isPublished: ctx.publish,
            sortOrder: 0,
            attributeAxes: ['size', 'colour'],
          })
          .returning({ id: productGroups.id, slug: productGroups.slug });
        if (!inserted) throw new Error(`Failed to insert group ${slug}`);
        groupSlugToId.set(slug, inserted.id);
        summary.groupsCreated++;
      }
    }

    // ── 2. products (one row per CSV row / SKU) ────────────────────
    const productSlugs = new Map<string, string>();
    for (const r of rows) {
      productSlugs.set(r.skuCode, `ralawise-${slugify(r.skuCode)}`);
    }
    const productSlugList = [...productSlugs.values()];
    const existingProducts = await tx
      .select({ id: products.id, slug: products.slug })
      .from(products)
      .where(
        and(
          eq(products.companyId, ctx.companyId),
          inArray(products.slug, productSlugList),
        ),
      );
    const productSlugToId = new Map<string, string>();
    for (const p of existingProducts) {
      if (p.slug) productSlugToId.set(p.slug, p.id);
    }

    for (const r of rows) {
      const slug = productSlugs.get(r.skuCode)!;
      const groupSlug = `ralawise-${slugify(r.styleCode)}`;
      const groupId = groupSlugToId.get(groupSlug);
      if (!groupId) {
        throw new Error(`Internal: missing group ${groupSlug} for SKU ${r.skuCode}`);
      }
      const attrs: Record<string, string> = {};
      if (r.sizeCode) attrs.size = r.sizeCode;
      if (r.colourName) attrs.colour = r.colourName;
      const longDescBits: string[] = [];
      if (r.retailDescription) longDescBits.push(r.retailDescription);
      if (r.specification) longDescBits.push(`### Specifications\n\n${r.specification}`);
      const longDescription = longDescBits.length > 0 ? longDescBits.join('\n\n') : null;
      const shortDescription = r.retailDescription ? r.retailDescription.slice(0, 280) : null;
      const productName = [r.styleName, r.colourName, r.sizeCode]
        .filter((s) => s && s.length > 0)
        .join(' · ')
        .slice(0, 500);

      const existingId = productSlugToId.get(slug);
      if (existingId) {
        await tx
          .update(products)
          .set({
            name: productName,
            stockCode: r.skuCode,
            groupId,
            colour: r.colourName || null,
            colourHex: r.colourHex,
            heroImageUrl: r.heroImageUrl,
            longDescription,
            shortDescription,
            minSellingPrice: r.retailGbp ?? undefined,
            maxSellingPrice: r.retailGbp ?? undefined,
            expectedNextCost: r.costGbp !== null ? r.costGbp.toFixed(2) : undefined,
            attributes: attrs,
            imageLicenceExpiresAt: r.imageLicenceExpiresAt,
            ...(ctx.publish ? { isPublished: true } : {}),
            updatedAt: new Date(),
          })
          .where(eq(products.id, existingId));
        summary.productsUpdated++;
      } else {
        const [inserted] = await tx
          .insert(products)
          .values({
            companyId: ctx.companyId,
            name: productName,
            stockCode: r.skuCode,
            description: shortDescription,
            expectedNextCost: r.costGbp !== null ? r.costGbp.toFixed(2) : '0',
            minSellingPrice: r.retailGbp ?? undefined,
            maxSellingPrice: r.retailGbp ?? undefined,
            productType: 'PHYSICAL' as const,
            groupId,
            colour: r.colourName || null,
            colourHex: r.colourHex,
            slug,
            shortDescription,
            longDescription,
            heroImageUrl: r.heroImageUrl,
            galleryImageUrls: r.heroImageUrl ? [r.heroImageUrl] : [],
            isPublished: ctx.publish,
            sortOrderInGroup: 0,
            attributes: attrs,
            supplierId: ctx.supplierId,
            imageLicenceExpiresAt: r.imageLicenceExpiresAt,
          })
          .returning({ id: products.id, slug: products.slug });
        if (!inserted) throw new Error(`Failed to insert variant ${slug}`);
        productSlugToId.set(slug, inserted.id);
        summary.productsCreated++;
      }
    }

    // ── 3. supplier_products ──────────────────────────────────────
    const variantProductIds = rows
      .map((r) => productSlugToId.get(productSlugs.get(r.skuCode)!))
      .filter((id): id is string => Boolean(id));
    const existingSP = variantProductIds.length === 0 ? [] : await tx
      .select({ id: supplierProducts.id, productId: supplierProducts.productId })
      .from(supplierProducts)
      .where(
        and(
          eq(supplierProducts.companyId, ctx.companyId),
          eq(supplierProducts.supplierId, ctx.supplierId),
          inArray(supplierProducts.productId, variantProductIds),
        ),
      );
    const productIdToSPId = new Map<string, string>();
    for (const sp of existingSP) productIdToSPId.set(sp.productId, sp.id);

    for (const r of rows) {
      const productId = productSlugToId.get(productSlugs.get(r.skuCode)!);
      if (!productId) continue;
      const cost = r.costGbp !== null ? r.costGbp.toFixed(2) : '0.00';
      const existingSpId = productIdToSPId.get(productId);
      if (existingSpId) {
        await tx
          .update(supplierProducts)
          .set({
            supplierSku: r.skuCode,
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
            companyId: ctx.companyId,
            productId,
            supplierId: ctx.supplierId,
            supplierSku: r.skuCode,
            costGbp: cost,
            isActive: true,
            priority: 100,
          });
        summary.supplierProductsCreated++;
      }
    }

    // ── 4. product_channels (only when channelId is set) ──────────
    if (ctx.channelId && variantProductIds.length > 0) {
      const existingPC = await tx
        .select({ id: productChannels.id, productId: productChannels.productId })
        .from(productChannels)
        .where(
          and(
            eq(productChannels.channelId, ctx.channelId),
            inArray(productChannels.productId, variantProductIds),
          ),
        );
      const existingPCSet = new Set(existingPC.map((pc) => pc.productId));

      // Only INSERT missing rows. Existing rows are left alone so
      // any admin-edited priceOverrideGbp / isOffered stays sacred.
      const toInsert = variantProductIds
        .filter((pid) => !existingPCSet.has(pid))
        .map((productId) => ({
          productId,
          channelId: ctx.channelId!,
          isOffered: true,
        }));
      if (toInsert.length > 0) {
        await tx.insert(productChannels).values(toInsert);
      }
      summary.productChannelsCreated += toInsert.length;
      summary.productChannelsUpdated += existingPC.length;
    }
  });

  // Touch sql() just to keep the import (some Drizzle environments
  // lazy-load the helper). No-op otherwise.
  void sql;
}

// ============================================================
// CSV streaming
// ============================================================

/**
 * Yields raw CSV rows from a file path. Uses `csv-parse` in streaming
 * mode. Strips BOM if present (the Ralawise CSV starts with one).
 */
export async function* streamCsv(csvPath: string): AsyncIterable<RalawiseRawRow> {
  if (!fs.existsSync(csvPath)) {
    throw new Error(
      `CSV not found at ${csvPath}. Set RALAWISE_CSV_PATH or pass --csv-path. ` +
        `The file is ~204 MB; get it from Ralawise's Marketing Hub → Web Data section.`,
    );
  }
  const stream = fs.createReadStream(csvPath).pipe(
    csvParse({
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: false,
      relax_column_count: true,
    }),
  );
  for await (const row of stream) {
    yield row as RalawiseRawRow;
  }
}

// ============================================================
// CLI entry point
// ============================================================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const companyId = getSingletonCompanyId();
  const db = getDb();

  // Resolve the Ralawise supplier row. The bootstrap script (§G) must
  // be run first.
  const supplier = await db.query.suppliers.findFirst({
    where: and(eq(suppliers.slug, 'ralawise'), isNull(suppliers.deletedAt)),
  });
  if (!supplier) {
    throw new Error(
      "No Ralawise supplier row found (slug='ralawise'). Run " +
        '`npx tsx apps/api/scripts/bootstrap-ralawise-supplier.ts` first.',
    );
  }

  // Resolve the channel id, if --channel was passed.
  let channelId: string | null = null;
  if (opts.channelSlug) {
    const ch = await db.query.channels.findFirst({
      where: and(eq(channels.slug, opts.channelSlug), isNull(channels.deletedAt)),
    });
    if (!ch) {
      throw new Error(
        `Channel slug '${opts.channelSlug}' not found. ` +
          "Pass --channel='' to skip channel rows, or create the channel first.",
      );
    }
    channelId = ch.id;
  }

  console.log(`[seed:ralawise] csv:      ${opts.csvPath}`);
  console.log(`[seed:ralawise] markup:   ${opts.markup.toFixed(2)}x`);
  console.log(`[seed:ralawise] channel:  ${opts.channelSlug ?? '(none — skipping product_channels)'}`);
  console.log(`[seed:ralawise] publish:  ${opts.publish}`);
  console.log(`[seed:ralawise] dry-run:  ${opts.dryRun}`);
  if (opts.limit !== null) console.log(`[seed:ralawise] limit:    ${opts.limit}`);
  console.log('');

  const startedAt = Date.now();
  const summary = await runImport(
    streamCsv(opts.csvPath),
    {
      companyId,
      supplierId: supplier.id,
      channelId,
      publish: opts.publish,
      dryRun: opts.dryRun,
    },
    {
      limit: opts.limit,
      markup: opts.markup,
      onProgress: (s) => {
        if (s.rowsRead % 5000 === 0) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
          console.log(
            `[seed:ralawise] ${s.rowsRead} rows read (${s.rowsConsidered} Live, ${s.rowsSkippedDiscontinued} discontinued) in ${elapsed}s`,
          );
        }
      },
    },
  );

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log('[seed:ralawise] summary:');
  console.log(`  elapsed                  : ${elapsed}s`);
  console.log(`  rows read                : ${summary.rowsRead}`);
  console.log(`  skipped (discontinued)   : ${summary.rowsSkippedDiscontinued}`);
  console.log(`  skipped (malformed)      : ${summary.rowsSkippedMalformed}`);
  console.log(`  considered               : ${summary.rowsConsidered}`);
  if (!summary.dryRun) {
    console.log(`  groups   created/updated : ${summary.groupsCreated} / ${summary.groupsUpdated}`);
    console.log(`  products created/updated : ${summary.productsCreated} / ${summary.productsUpdated}`);
    console.log(`  supplier_products c/u    : ${summary.supplierProductsCreated} / ${summary.supplierProductsUpdated}`);
    console.log(`  product_channels c/u     : ${summary.productChannelsCreated} / ${summary.productChannelsUpdated}`);
  }
  if (summary.malformedExamples.length > 0) {
    console.log('');
    console.log('Malformed row examples (first 10):');
    for (const ex of summary.malformedExamples) {
      console.log(`  row ${ex.rowIndex}: ${ex.reason}`);
    }
  }
  console.log(summary.dryRun ? '\n[seed:ralawise] dry-run complete.' : '\n[seed:ralawise] OK.');
}

const isCliEntry = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const here = fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase();
    const argv1 = entry.replace(/\\/g, '/').toLowerCase();
    return here === argv1 || here.endsWith(argv1) || argv1.endsWith(here);
  } catch {
    return false;
  }
})();

if (isCliEntry || process.argv[1]?.endsWith('seed-ralawise-catalogue.ts')) {
  main()
    .catch((err) => {
      console.error('[seed:ralawise] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabase();
    });
}
