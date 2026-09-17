/**
 * Attach the supplier codes BumbleBee's invoices prove exist to Auto-Stock
 * products.
 *
 *   npx tsx apps/api/scripts/import-invoice-skus.ts --dry-run
 *   npx tsx apps/api/scripts/import-invoice-skus.ts
 *
 * Reads the CSVs written by `extract-invoice-skus.ts` - never BumbleBee
 * directly, so what gets imported is exactly what was reviewed.
 *
 * TWO MODES, and the second is where most of the codes come from:
 *
 *   (default)            place the codes that identify their own product -
 *                        the stock code matches, or the invoice description is
 *                        the product's exact name. ~30 of 460.
 *   --decisions=<csv>    place the rest from a match-review sheet a human has
 *                        filled in, which can also CREATE the products that
 *                        were missing. See `importInvoiceSkuDecisions` and
 *                        `modules/suppliers/invoice-sku-decisions.ts`.
 *
 * The decisions run exits non-zero if any row was refused, having written
 * every row that was not: a handful of unanswered questions should not hold
 * back four hundred answered ones, but they must not scroll past either.
 *
 * Auto-Stock cannot raise a purchase order for a product it has no supplier
 * code for. This writes `supplier_products` (the purchasable line: code, pack
 * size, last known cost) plus `supplier_product_aliases` (the other spellings
 * the same code arrives as - see migration 0052).
 *
 * MATCHING IS THE HARD PART, AND IT REFUSES TO GUESS. An invoice line names
 * goods the way the SUPPLIER describes them ("Wholesome Farms Unsalted
 * Butter"); Auto-Stock names them the way the VENUE counts them ("Butter,
 * unsalted"). This matches on stock code first, then on an exact normalised
 * name, and stops there. Anything else is listed as unmatched for a human to
 * place from the product page. A fuzzy match that is wrong attaches a
 * supplier's code, pack size and price to the wrong product, and every
 * reorder for both products is wrong afterwards with nothing on screen saying
 * so - strictly worse than a mapping nobody made yet.
 *
 * NEVER OVERWRITES A COST SOMEONE TYPED. An operator who entered a price
 * agreed with the supplier knows more than an OCR'd invoice from four months
 * ago. An existing mapping is gap-filled only: a blank cost gets one, anything
 * already written stands. Aliases are ADDED to, never replaced, for the same
 * reason.
 *
 * IT DOES NOT SET THE PACK SIZE. `supplier_pack_size` is a NUMBER - how many
 * purchase units come in one pack - and the reorder engine rounds an order up
 * to whole packs with it. The invoice only has free text, and that text does
 * not decode safely: Brakes bills compactor sacks as `100x1` (a hundred sacks)
 * and gloves as `1x100` (one box of a hundred), the same shape meaning
 * opposite things. Getting it backwards orders a hundred times too many or too
 * few, so the observed text is carried into the CSV for a human to read and
 * the column is left for them to set. The run ends by listing the mappings
 * waiting on one, busiest first.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { parse as csvParse } from 'csv-parse/sync';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, supplierProductAliases, supplierProducts, suppliers } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { aliasConflict, normaliseSku } from '../src/modules/suppliers/supplier-sku-resolver.js';
import {
  normaliseName as normaliseDecisionName,
  planDecisions,
  type DecisionRow,
} from '../src/modules/suppliers/invoice-sku-decisions.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'invoice-skus');

export interface InvoiceSkuRow {
  supplier: string;
  supplierSku: string;
  aliases: string[];
  description: string;
  packSize: string;
  unitCostGbp: string | null;
  linesSeen: number;
  lastSeen: string;
}

export function readSkuCsv(text: string): InvoiceSkuRow[] {
  const records = csvParse(text, { columns: true, skip_empty_lines: true, bom: true }) as Array<
    Record<string, string>
  >;
  return records.map((r) => ({
    supplier: (r.supplier ?? '').trim(),
    supplierSku: (r.supplier_sku ?? '').trim(),
    // The extractor writes aliases comma-separated. Commas ONLY: a supplier
    // code can contain a space ("A 33891"), so splitting on whitespace would
    // turn one real code into two invented ones.
    aliases: (r.aliases ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0),
    description: (r.description ?? '').trim(),
    packSize: (r.pack_size ?? '').trim(),
    unitCostGbp: (r.unit_cost_gbp ?? '').trim() || null,
    linesSeen: Number(r.lines_seen) || 0,
    lastSeen: (r.last_seen ?? '').trim(),
  }));
}

/**
 * How a product name is compared. Case, punctuation and runs of whitespace are
 * noise; word order and the words themselves are not. Deliberately NOT a
 * similarity score - see the header.
 */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface ImportReport {
  created: number;
  gapFilled: number;
  unchanged: number;
  aliasesAdded: number;
  /** Mappings with no numeric pack size. See the header: not guessed from the
   *  invoice text. The text that WAS observed travels with each one. */
  packSizeWanted: Array<{ supplier: string; sku: string; observedPack: string; linesSeen: number }>;
  /** Rows whose supplier has no row in Auto-Stock. */
  unknownSupplier: Array<{ supplier: string; codes: number }>;
  /** Rows matched to no product. The work list, biggest spenders first. */
  unmatched: Array<{ supplier: string; sku: string; description: string; linesSeen: number }>;
  /** An alias here is already some OTHER mapping's code. Skipped, never merged. */
  aliasConflicts: Array<{ supplier: string; sku: string; alias: string; reason: string }>;
  /** This supplier already uses this code for a DIFFERENT product. Skipped.
   *  See `attachSupplierCode`: one code cannot mean two things. */
  skuOnOtherProduct: Array<{
    supplier: string; sku: string; description: string;
    currentProduct: string; currentStockCode: string | null;
  }>;
}

/**
 * Write one supplier code against one product, plus its other spellings.
 *
 * Shared by both modes so a code placed by a reviewed decision gets exactly
 * the same treatment as one the code-first pass placed itself - gap-fill only,
 * aliases added never replaced, pack size left for a human.
 */
async function attachSupplierCode(args: {
  row: InvoiceSkuRow;
  /** null on a dry run whose product would have been created by this same run:
   *  there is no id to look up, and a product that does not exist cannot
   *  already carry this code. Querying with a placeholder id blew up on the
   *  uuid cast, which is how this was found. */
  productId: string | null;
  supplierId: string;
  companyId: string;
  dry: boolean;
  report: ImportReport;
}): Promise<void> {
  const { row, productId, supplierId, companyId, dry, report } = args;
  const db = getDb();

  const existing = productId
    ? await db.query.supplierProducts.findFirst({
        where: and(
          eq(supplierProducts.companyId, companyId),
          eq(supplierProducts.productId, productId),
          eq(supplierProducts.supplierId, supplierId),
          eq(supplierProducts.supplierSku, row.supplierSku),
        ),
      })
    : undefined;

  let supplierProductId = existing?.id ?? null;
  if (existing) {
    // Gap-fill only. Whatever the operator already put there stands.
    const patch: Record<string, unknown> = {};
    if (existing.costGbp == null && row.unitCostGbp) patch.costGbp = row.unitCostGbp;
    if (existing.supplierPackSize == null && row.packSize) {
      report.packSizeWanted.push({
        supplier: row.supplier, sku: row.supplierSku,
        observedPack: row.packSize, linesSeen: row.linesSeen,
      });
    }
    if (Object.keys(patch).length === 0) {
      report.unchanged += 1;
    } else {
      report.gapFilled += 1;
      if (!dry) {
        await db
          .update(supplierProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(supplierProducts.id, existing.id));
      }
    }
  } else {
    // ONE CODE CANNOT MEAN TWO THINGS.
    //
    // The existing-mapping lookup above is keyed on (product, supplier, sku),
    // so it misses when this supplier already uses this code against a
    // DIFFERENT product - and the insert would then put the same code on two
    // purchasable lines. The reorder engine ranks those lines against each
    // other by pack size and price, so the phantom can win the order and the
    // PO goes out for the wrong goods with nothing on screen saying so.
    //
    // This is not hypothetical here: the July 2026 supplier-catalogue import
    // predates the alias table (migration 0052) and filed every spelling of a
    // code as its own canonical line, so ~700 rows are already holding these
    // codes. Refuse and name it; a human decides which product is right.
    const elsewhere = await db
      .select({ productName: products.name, productStockCode: products.stockCode })
      .from(supplierProducts)
      .innerJoin(products, eq(products.id, supplierProducts.productId))
      .where(
        and(
          eq(supplierProducts.companyId, companyId),
          eq(supplierProducts.supplierId, supplierId),
          isNull(supplierProducts.deletedAt),
          sql`lower(btrim(${supplierProducts.supplierSku})) = ${normaliseSku(row.supplierSku)}`,
        ),
      )
      .limit(1);
    if (elsewhere[0]) {
      report.skuOnOtherProduct.push({
        supplier: row.supplier,
        sku: row.supplierSku,
        description: row.description,
        currentProduct: elsewhere[0].productName,
        currentStockCode: elsewhere[0].productStockCode,
      });
      return;
    }

    report.created += 1;
    if (!dry && productId) {
      const [ins] = await db
        .insert(supplierProducts)
        .values({
          companyId,
          productId,
          supplierId,
          supplierSku: row.supplierSku,
          costGbp: row.unitCostGbp,
          // supplierPackSize, priority and isActive stay at their schema
          // defaults. An invoice says nothing about which supplier to prefer,
          // and guessing a priority silently reorders every proposal for that
          // product; the pack size is the header's `100x1` problem.
        })
        .returning();
      supplierProductId = ins!.id;
    }
    if (row.packSize) {
      report.packSizeWanted.push({
        supplier: row.supplier, sku: row.supplierSku,
        observedPack: row.packSize, linesSeen: row.linesSeen,
      });
    }
  }

  for (const alias of row.aliases) {
    if (normaliseSku(alias) === normaliseSku(row.supplierSku)) continue;
    // Uniqueness spans supplier_products AND supplier_product_aliases, which
    // no single index can see across - so ask before writing.
    const clash = await aliasConflict(supplierId, alias, supplierProductId, companyId);
    if (clash) {
      report.aliasConflicts.push({
        supplier: row.supplier,
        sku: row.supplierSku,
        alias,
        reason: clash.reason,
      });
      continue;
    }
    report.aliasesAdded += 1;
    if (!dry && supplierProductId) {
      await db.insert(supplierProductAliases).values({
        companyId,
        supplierProductId,
        supplierId,
        aliasSku: alias,
        source: 'INVOICE_OCR',
        lastSeenAt: row.lastSeen ? new Date(row.lastSeen) : null,
      });
    }
  }
}

export async function importInvoiceSkus(
  opts: { dryRun?: boolean; file?: string; companyId?: string } = {},
): Promise<ImportReport> {
  // Defaulted rather than hardcoded, matching resolveSupplierSku/aliasConflict.
  // Tests pass a throwaway id so a run cannot touch rows another test file is
  // reading — supplier_products is shared state and vitest runs files together.
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const db = getDb();
  const dry = opts.dryRun ?? false;
  const rows = readSkuCsv(
    readFileSync(opts.file ?? join(DATA_DIR, 'supplier-skus.csv'), 'utf8'),
  );

  const report: ImportReport = {
    created: 0, gapFilled: 0, unchanged: 0, aliasesAdded: 0,
    packSizeWanted: [], unknownSupplier: [], unmatched: [], aliasConflicts: [],
    skuOnOtherProduct: [],
  };

  const supplierRows = await db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.companyId, companyId));
  // Matched case-insensitively: the catalogue import wrote "Makro" and the
  // invoices say "makro". An exact match would report a supplier that exists
  // as missing.
  const supplierByName = new Map(supplierRows.map((s) => [s.name.trim().toLowerCase(), s.id]));

  const productRows = await db
    .select({ id: products.id, name: products.name, stockCode: products.stockCode })
    .from(products)
    .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));
  const byStockCode = new Map<string, string>();
  // A name shared by two live products cannot identify either of them, so it
  // identifies NEITHER - the entry is poisoned rather than resolved to the
  // first one seen.
  const byName = new Map<string, string | null>();
  for (const p of productRows) {
    if (p.stockCode) byStockCode.set(normaliseSku(p.stockCode), p.id);
    const n = normaliseName(p.name);
    if (!n) continue;
    byName.set(n, byName.has(n) ? null : p.id);
  }

  const unknownSupplierCounts = new Map<string, number>();

  for (const row of rows) {
    if (!row.supplier || !row.supplierSku) continue;
    const supplierId = supplierByName.get(row.supplier.toLowerCase());
    if (!supplierId) {
      unknownSupplierCounts.set(row.supplier, (unknownSupplierCounts.get(row.supplier) ?? 0) + 1);
      continue;
    }

    const productId =
      byStockCode.get(normaliseSku(row.supplierSku)) ?? byName.get(normaliseName(row.description)) ?? null;
    if (!productId) {
      report.unmatched.push({
        supplier: row.supplier,
        sku: row.supplierSku,
        description: row.description,
        linesSeen: row.linesSeen,
      });
      continue;
    }

    await attachSupplierCode({ row, productId, supplierId, companyId, dry, report });
  }

  report.unknownSupplier = [...unknownSupplierCounts]
    .map(([supplier, codes]) => ({ supplier, codes }))
    .sort((a, b) => b.codes - a.codes);
  // Most-billed first: the unmatched list is a work list, and the code seen on
  // 158 invoice lines is worth placing before the one seen twice.
  report.unmatched.sort((a, b) => b.linesSeen - a.linesSeen);
  report.packSizeWanted.sort((a, b) => b.linesSeen - a.linesSeen);
  return report;
}

/* ------------------------------------------------------------------ *
 * Decisions mode: `--decisions=<reviewed match-review.csv>`
 * ------------------------------------------------------------------ */

export interface DecisionsReport extends ImportReport {
  productsCreated: Array<{ name: string; stockCode: string; stockUom: string; codes: number }>;
  adoptedExisting: Array<{ supplier: string; supplierSku: string; name: string; stockCode: string | null }>;
  notStock: number;
  undecided: Array<{ supplier: string; supplierSku: string; description: string }>;
  refusals: Array<{ supplier: string; supplierSku: string; description: string; reason: string }>;
}

export function readDecisionCsv(text: string): DecisionRow[] {
  const records = csvParse(text, { columns: true, skip_empty_lines: true, bom: true }) as Array<
    Record<string, string>
  >;
  return records.map((r) => ({
    supplier: (r.supplier ?? '').trim(),
    // Sheets marks a cell as text with a leading apostrophe so `092709` keeps
    // its zero. The export normally strips it again, but a file saved another
    // way may not - and a code read as `'092709` matches nothing.
    supplierSku: (r.supplier_sku ?? '').trim().replace(/^'/, ''),
    description: (r.description ?? '').trim(),
    decision: (r.decision ?? '').trim(),
    proposedStockCode: (r.proposed_stock_code ?? '').trim(),
    newProductName: (r.new_product_name ?? '').trim(),
    newStockUom: (r.new_stock_uom ?? '').trim(),
    linesSeen: Number(r.lines_seen) || 0,
  }));
}

/**
 * Apply a reviewed match-review sheet.
 *
 * The sheet says WHICH PRODUCT each code belongs to and nothing else - it
 * carries no aliases and no last-seen date, because a reviewer should not have
 * to preserve columns they are not judging. Those facts are rejoined from
 * `supplier-skus.csv`, the extractor's own output, on `(supplier, sku)`. A
 * decision for a code that is not in that file is refused rather than written
 * from the sheet alone: the sheet is a review of the extract, and a row that
 * outlived its extract has lost the evidence behind it.
 */
export async function importInvoiceSkuDecisions(
  opts: { dryRun?: boolean; decisionsFile: string; skusFile?: string; companyId?: string },
): Promise<DecisionsReport> {
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const db = getDb();
  const dry = opts.dryRun ?? false;

  const decisions = readDecisionCsv(readFileSync(opts.decisionsFile, 'utf8'));
  const skuRows = readSkuCsv(readFileSync(opts.skusFile ?? join(DATA_DIR, 'supplier-skus.csv'), 'utf8'));
  const skuByKey = new Map(
    skuRows.map((r) => [`${r.supplier.toLowerCase()}\u0000${normaliseSku(r.supplierSku)}`, r]),
  );

  const report: DecisionsReport = {
    created: 0, gapFilled: 0, unchanged: 0, aliasesAdded: 0,
    packSizeWanted: [], unknownSupplier: [], unmatched: [], aliasConflicts: [],
    skuOnOtherProduct: [],
    productsCreated: [], adoptedExisting: [], notStock: 0, undecided: [], refusals: [],
  };

  const supplierRows = await db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.companyId, companyId));
  const supplierByName = new Map(supplierRows.map((s) => [s.name.trim().toLowerCase(), s.id]));

  const liveProducts = await db
    .select({ id: products.id, name: products.name, stockCode: products.stockCode })
    .from(products)
    .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));
  // Soft-deleted rows included: `(company, slug)` is unique regardless of
  // `deleted_at`, so a slug the duplicate merge retired is still occupied.
  const allSlugs = await db
    .select({ slug: products.slug, stockCode: products.stockCode })
    .from(products)
    .where(eq(products.companyId, companyId));
  const reserved = allSlugs.flatMap((r) => [r.slug, r.stockCode].filter((v): v is string => !!v));

  const plan = planDecisions(decisions, liveProducts, reserved);
  report.refusals = plan.refusals;
  report.adoptedExisting = plan.adoptedExisting;
  report.notStock = plan.skipped.length;
  report.undecided = plan.undecided;

  // Products first: a resolved row cannot be attached to a product that does
  // not exist yet, and both halves share one transaction so a failure here
  // leaves no half-created catalogue behind.
  const newIdByKey = new Map<string, string>();
  await db.transaction(async (tx) => {
    for (const np of plan.newProducts) {
      report.productsCreated.push({
        name: np.name, stockCode: np.stockCode, stockUom: np.stockUom, codes: np.askedBy.length,
      });
      // No placeholder id on a dry run - `attachSupplierCode` takes null and
      // reports the code as one it WOULD create.
      if (dry) continue;
      const [created] = await tx
        .insert(products)
        .values({
          companyId,
          name: np.name,
          slug: np.slug,
          stockCode: np.stockCode,
          stockUom: np.stockUom,
          itemKind: 'RETAIL',
          // Bought in, counted, never sold through a storefront - the same
          // shape as the recipe-imported ingredients.
          isSold: false,
          isStocked: true,
          // purchaseUom, purchaseToStockFactor, packDescription and
          // expectedNextCost are deliberately left at their defaults, which
          // puts every one of these on the Needs-setup list. The invoice
          // cannot supply them honestly: its cost is per PACK ("1 x 25kg" at
          // GBP 25.40) and writing that into expectedNextCost - which is per
          // purchase unit against a factor of 1 - would price the ingredient
          // at GBP 25.40 per kg in every recipe that used it. The pack price
          // goes where it is true, on the supplier line.
        })
        .returning();
      newIdByKey.set(normaliseDecisionName(np.name), created!.id);
    }
  });

  for (const row of plan.resolved) {
    const sku = skuByKey.get(`${row.supplier.toLowerCase()}\u0000${normaliseSku(row.supplierSku)}`);
    if (!sku) {
      report.refusals.push({
        supplier: row.supplier, supplierSku: row.supplierSku, description: row.description,
        reason: 'no row for this code in supplier-skus.csv - re-run the extractor, or the sheet is stale',
      });
      continue;
    }
    const supplierId = supplierByName.get(row.supplier.toLowerCase());
    if (!supplierId) {
      report.refusals.push({
        supplier: row.supplier, supplierSku: row.supplierSku, description: row.description,
        reason: 'no supplier row in Auto-Stock - run import-invoice-suppliers.ts first',
      });
      continue;
    }
    const productId = row.productId ?? (row.newProductKey ? newIdByKey.get(row.newProductKey) ?? null : null);
    if (!productId && !(dry && row.via === 'ADD_NEW')) {
      report.refusals.push({
        supplier: row.supplier, supplierSku: row.supplierSku, description: row.description,
        reason: 'its new product was not created',
      });
      continue;
    }
    await attachSupplierCode({ row: sku, productId, supplierId, companyId, dry, report });
  }

  report.packSizeWanted.sort((a, b) => b.linesSeen - a.linesSeen);
  report.refusals.sort((a, b) => a.supplier.localeCompare(b.supplier));
  return report;
}

const isCliEntry = process.argv[1]?.endsWith('import-invoice-skus.ts') ?? false;

function reportDecisions(r: DecisionsReport, dryRun: boolean): void {
  console.log(`[import-invoice-skus] decisions ${dryRun ? 'DRY RUN - nothing written' : 'APPLIED'}`);
  console.log(`  products created     : ${r.productsCreated.length}`);
  console.log(`  supplier codes placed: ${r.created}`);
  console.log(`  gap-filled           : ${r.gapFilled}  (a blank cost only)`);
  console.log(`  unchanged            : ${r.unchanged}`);
  console.log(`  aliases added        : ${r.aliasesAdded}`);
  console.log(`  not a stock item     : ${r.notStock}`);
  console.log(`  left undecided       : ${r.undecided.length}`);

  if (r.adoptedExisting.length > 0) {
    console.log(`\n  ${r.adoptedExisting.length} "ADD ITEM" row(s) named a product that already exists.`);
    console.log('  Attached to it rather than creating a second one of the same name:');
    for (const a of r.adoptedExisting) {
      console.log(`    ${a.supplier} ${a.supplierSku} -> ${a.name} [${a.stockCode ?? 'no code'}]`);
    }
  }
  if (r.productsCreated.length > 0) {
    console.log(`\n  ${r.productsCreated.length} new product(s). Every one is on the Needs-setup list:`);
    console.log('  no purchase unit, no pack size, no cost - none of which an invoice can');
    console.log('  supply honestly (its price is per PACK). Finish them there.');
    for (const p of r.productsCreated.slice(0, 15)) {
      console.log(`    ${p.stockCode.padEnd(16)} ${p.stockUom.padEnd(5)} ${p.name}${p.codes > 1 ? `  (${p.codes} supplier codes)` : ''}`);
    }
    if (r.productsCreated.length > 15) console.log(`    ... and ${r.productsCreated.length - 15} more`);
  }
  if (r.packSizeWanted.length > 0) {
    console.log(`\n  ${r.packSizeWanted.length} mapping(s) have no pack size - see the header. Busiest first:`);
    for (const p of r.packSizeWanted.slice(0, 10)) {
      console.log(`    ${String(p.linesSeen).padStart(4)} lines  ${p.supplier} ${p.sku}  billed as "${p.observedPack}"`);
    }
    if (r.packSizeWanted.length > 10) console.log(`    ... and ${r.packSizeWanted.length - 10} more`);
  }
  if (r.skuOnOtherProduct.length > 0) {
    console.log(`\n  ${r.skuOnOtherProduct.length} code(s) SKIPPED - this supplier already uses them for a`);
    console.log('  different product. One code cannot mean two things, and a second');
    console.log('  purchasable line can win a reorder. Decide which product is right:');
    for (const c of r.skuOnOtherProduct.slice(0, 20)) {
      console.log(`    ${c.supplier} ${c.sku}  "${c.description}"`);
      console.log(`      currently on: ${c.currentProduct} [${c.currentStockCode ?? 'no code'}]`);
    }
    if (r.skuOnOtherProduct.length > 20) console.log(`    ... and ${r.skuOnOtherProduct.length - 20} more`);
  }
  if (r.aliasConflicts.length > 0) {
    console.log(`\n  ${r.aliasConflicts.length} alias(es) are already another mapping's code - skipped:`);
    for (const a of r.aliasConflicts.slice(0, 10)) console.log(`    ${a.supplier} ${a.sku}: ${a.alias} - ${a.reason}`);
  }
  if (r.undecided.length > 0) {
    console.log(`\n  ${r.undecided.length} row(s) have an empty decision. Left alone - fill them in and re-run:`);
    for (const u of r.undecided) console.log(`    ${u.supplier} ${u.supplierSku}  ${u.description}`);
  }
  if (r.refusals.length > 0) {
    console.log(`\n  ${r.refusals.length} row(s) REFUSED. Nothing was written for these:`);
    for (const f of r.refusals) console.log(`    ${f.supplier} ${f.supplierSku}  ${f.description}\n      ${f.reason}`);
  }
}

if (isCliEntry) {
  const dryRun = process.argv.includes('--dry-run');
  const decisionsArg = process.argv.find((a) => a.startsWith('--decisions='));

  if (decisionsArg) {
    const decisionsFile = decisionsArg.slice('--decisions='.length);
    const skusArg = process.argv.find((a) => a.startsWith('--skus='));
    importInvoiceSkuDecisions({
      dryRun, decisionsFile, skusFile: skusArg?.slice('--skus='.length),
    })
      .then((r) => {
        reportDecisions(r, dryRun);
        // A refusal is a row a human still has to answer, and a zero exit
        // would let it scroll past in a deploy log. The rows that DID resolve
        // are still written - 3 unanswered questions should not hold up 428
        // answered ones.
        if (r.refusals.length > 0) process.exitCode = 1;
      })
      .catch((err) => {
        console.error('[import-invoice-skus] FAILED:', err instanceof Error ? err.message : err);
        process.exitCode = 1;
      })
      .finally(() => closeDatabase());
  } else {
  importInvoiceSkus({ dryRun })
    .then((r) => {
      console.log(`[import-invoice-skus] ${dryRun ? 'DRY RUN - nothing written' : 'OK'}`);
      console.log(`  mappings created : ${r.created}`);
      console.log(`  gap-filled       : ${r.gapFilled}  (a blank cost only)`);
      console.log(`  unchanged        : ${r.unchanged}`);
      console.log(`  aliases added    : ${r.aliasesAdded}`);
      if (r.packSizeWanted.length > 0) {
        console.log(`\n  ${r.packSizeWanted.length} mapping(s) have no pack size. Not read off the invoice`);
        console.log('  text - see the header. Set them so a PO rounds to whole packs:');
        for (const p of r.packSizeWanted.slice(0, 10)) {
          console.log(`    ${String(p.linesSeen).padStart(4)} lines  ${p.supplier} ${p.sku}  billed as "${p.observedPack}"`);
        }
        if (r.packSizeWanted.length > 10) console.log(`    ... and ${r.packSizeWanted.length - 10} more`);
      }
      if (r.unknownSupplier.length > 0) {
        console.log('\n  No supplier row in Auto-Stock for:');
        for (const s of r.unknownSupplier) console.log(`    ${String(s.codes).padStart(5)} code(s)  ${s.supplier}`);
        console.log('  Run import-invoice-suppliers.ts first, or rename to match.');
      }
      if (r.aliasConflicts.length > 0) {
        console.log(`\n  ${r.aliasConflicts.length} alias(es) are already another mapping's code - skipped:`);
        for (const a of r.aliasConflicts.slice(0, 10)) {
          console.log(`    ${a.supplier} ${a.sku}: ${a.alias} - ${a.reason}`);
        }
      }
      if (r.unmatched.length > 0) {
        console.log(`\n  ${r.unmatched.length} code(s) match no product. Not guessed - see the header.`);
        console.log('  Most-billed first:');
        for (const u of r.unmatched.slice(0, 20)) {
          console.log(`    ${String(u.linesSeen).padStart(4)} lines  ${u.supplier} ${u.sku}  ${u.description}`);
        }
        if (r.unmatched.length > 20) console.log(`    ... and ${r.unmatched.length - 20} more`);
        console.log('\n  Attach them on the product page: https://stock.thebigbakes.com/products');
      }
    })
    .catch((err) => {
      console.error('[import-invoice-skus] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
  }
}
