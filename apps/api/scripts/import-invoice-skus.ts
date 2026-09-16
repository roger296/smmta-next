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
import { and, eq, isNull } from 'drizzle-orm';
import { parse as csvParse } from 'csv-parse/sync';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, supplierProductAliases, supplierProducts, suppliers } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { aliasConflict, normaliseSku } from '../src/modules/suppliers/supplier-sku-resolver.js';

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

    const existing = await db.query.supplierProducts.findFirst({
      where: and(
        eq(supplierProducts.companyId, companyId),
        eq(supplierProducts.productId, productId),
        eq(supplierProducts.supplierId, supplierId),
        eq(supplierProducts.supplierSku, row.supplierSku),
      ),
    });

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
      report.created += 1;
      if (!dry) {
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

  report.unknownSupplier = [...unknownSupplierCounts]
    .map(([supplier, codes]) => ({ supplier, codes }))
    .sort((a, b) => b.codes - a.codes);
  // Most-billed first: the unmatched list is a work list, and the code seen on
  // 158 invoice lines is worth placing before the one seen twice.
  report.unmatched.sort((a, b) => b.linesSeen - a.linesSeen);
  report.packSizeWanted.sort((a, b) => b.linesSeen - a.linesSeen);
  return report;
}

const isCliEntry = process.argv[1]?.endsWith('import-invoice-skus.ts') ?? false;

if (isCliEntry) {
  const dryRun = process.argv.includes('--dry-run');
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
