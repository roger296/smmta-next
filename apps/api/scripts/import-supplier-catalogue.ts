/**
 * Import suppliers, their SKUs, and the products only they know about.
 *
 *   npx tsx apps/api/scripts/import-supplier-catalogue.ts --dry-run
 *   npx tsx apps/api/scripts/import-supplier-catalogue.ts
 *
 * Reads the CSVs written by `extract-supplier-catalogue.py` — never the
 * spreadsheet directly, so what gets imported is exactly what was reviewed.
 *
 * Idempotent on every table: suppliers match on name, products on stock code,
 * and supplier products on the (product, supplier, supplierSku) unique index
 * added in migration 0037. Re-running after Rebecca fills gaps only adds.
 *
 * PREFERRED SUPPLIER: where a product has several, priority is assigned
 * cheapest-first — except that placeholder-priced rows (GBP0.10, meaning "no
 * price supplied") are pushed to the back. Otherwise the rows we know least
 * about would always look cheapest and win every time.
 *
 * PLACEHOLDERS: rows the sheet couldn't supply come in marked rather than
 * dropped — GBP0.10 for an unknown price, "NOSKU" for an unknown supplier code.
 * Both are deliberately conspicuous. A NOSKU line prints as-is on a purchase
 * order, so it cannot be mistaken for a real code, and neither value can be
 * confused with genuine costing.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, suppliers, supplierProducts } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'supplier-catalogue');
/** Must match PLACEHOLDER_PRICE in the extractor. */
const PLACEHOLDER_PRICE = 0.1;
/** Must match PLACEHOLDER_SKU in the extractor. */
const PLACEHOLDER_SKU = 'NOSKU';
/** Stands in for a row a dry run would have created but didn't. */
const DRY_ID = '__dry__';

function readCsv(name: string): Array<Record<string, string>> {
  const text = readFileSync(join(DATA_DIR, name), 'utf8').replace(/^﻿/, '').trim();
  const rows = text.split(/\r?\n/).map(splitCsvLine);
  const header = rows[0]!;
  return rows.slice(1).map((cells) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (cells[i] ?? '').trim()));
    return o;
  });
}

/** Quoted fields carry commas — product names are full of them. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export interface ImportReport {
  suppliersCreated: number;
  suppliersExisting: number;
  productsCreated: number;
  productsExisting: number;
  mappingsWritten: number;
  mappingsUpdated: number;
  placeholderPriced: number;
  placeholderSku: number;
  unknownProduct: string[];
}

export async function importSupplierCatalogue(
  opts: { dryRun?: boolean } = {},
): Promise<ImportReport> {
  const companyId = getSingletonCompanyId();
  const db = getDb();
  const dry = opts.dryRun ?? false;
  const report: ImportReport = {
    suppliersCreated: 0,
    suppliersExisting: 0,
    productsCreated: 0,
    productsExisting: 0,
    mappingsWritten: 0,
    mappingsUpdated: 0,
    placeholderPriced: 0,
    placeholderSku: 0,
    unknownProduct: [],
  };

  // ── suppliers ──────────────────────────────────────────────────────
  const supplierIds = new Map<string, string>();
  for (const row of readCsv('suppliers.csv')) {
    const existing = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.companyId, companyId), eq(suppliers.name, row.name!)),
    });
    if (existing) {
      supplierIds.set(row.name!, existing.id);
      report.suppliersExisting += 1;
      continue;
    }
    report.suppliersCreated += 1;
    if (dry) {
      // A dry run creates nothing, so stand in a marker — otherwise every
      // mapping below fails its lookup and the run reports zero work, which is
      // exactly the number you must not trust before a real import.
      supplierIds.set(row.name!, DRY_ID);
      continue;
    }
    const [created] = await db
      .insert(suppliers)
      .values({ companyId, name: row.name!, slug: row.slug || null })
      .returning();
    supplierIds.set(row.name!, created!.id);
  }

  // ── products the sheet prices but the count list never had ─────────
  const wouldExist = new Set<string>();
  for (const row of readCsv('products-new.csv')) {
    const existing = await db.query.products.findFirst({
      where: and(eq(products.companyId, companyId), eq(products.stockCode, row.sku!)),
    });
    if (existing) {
      report.productsExisting += 1;
      continue;
    }
    report.productsCreated += 1;
    if (dry) {
      wouldExist.add(row.sku!);
      continue;
    }
    await db.insert(products).values({
      companyId,
      stockCode: row.sku!,
      name: row.name!,
      slug: row.slug || null,
      stockUom: row.stock_uom || 'each',
      // Deliberately NOT mapped to a count-sheet category: these are bought,
      // not counted. An unmapped product simply doesn't appear on the sheet,
      // which is the correct place for bin liners and till rolls.
    });
  }

  // ── the mappings ───────────────────────────────────────────────────
  const mappings = readCsv('supplier-products.csv');

  // Cheapest first, placeholders last — see the header note on priority.
  const byProduct = new Map<string, Array<Record<string, string>>>();
  for (const m of mappings) {
    const list = byProduct.get(m.sku!) ?? [];
    list.push(m);
    byProduct.set(m.sku!, list);
  }

  for (const [sku, rows] of byProduct) {
    const product = await db.query.products.findFirst({
      where: and(eq(products.companyId, companyId), eq(products.stockCode, sku)),
    });
    if (!product && !(dry && wouldExist.has(sku))) {
      report.unknownProduct.push(sku);
      continue;
    }

    const ordered = [...rows].sort((a, b) => {
      const ap = a.price_is_placeholder === 'yes' ? 1 : 0;
      const bp = b.price_is_placeholder === 'yes' ? 1 : 0;
      if (ap !== bp) return ap - bp;
      return Number(a.cost_gbp) - Number(b.cost_gbp);
    });

    for (const [idx, m] of ordered.entries()) {
      if (m.price_is_placeholder === 'yes') report.placeholderPriced += 1;
      if (m.sku_is_placeholder === 'yes') report.placeholderSku += 1;
      const supplierId = supplierIds.get(m.supplier!);
      if (!supplierId) continue;
      if (dry || supplierId === DRY_ID || !product) {
        report.mappingsWritten += 1;
        continue;
      }

      const existing = await db.query.supplierProducts.findFirst({
        where: and(
          eq(supplierProducts.companyId, companyId),
          eq(supplierProducts.productId, product.id),
          eq(supplierProducts.supplierId, supplierId),
          eq(supplierProducts.supplierSku, m.supplier_sku!),
        ),
      });
      const values = {
        costGbp: Number(m.cost_gbp).toFixed(2),
        supplierPackSize: m.pack_size ? Number(m.pack_size).toFixed(3) : null,
        priority: 100 + idx,
        isActive: true,
      };
      if (existing) {
        await db
          .update(supplierProducts)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(supplierProducts.id, existing.id));
        report.mappingsUpdated += 1;
      } else {
        await db.insert(supplierProducts).values({
          companyId,
          productId: product.id,
          supplierId,
          supplierSku: m.supplier_sku!,
          ...values,
        });
        report.mappingsWritten += 1;
      }
    }
  }

  return report;
}

const isCliEntry = process.argv[1]?.endsWith('import-supplier-catalogue.ts') ?? false;

if (isCliEntry) {
  const dryRun = process.argv.includes('--dry-run');
  importSupplierCatalogue({ dryRun })
    .then((r) => {
      console.log(`[import-supplier-catalogue] ${dryRun ? 'DRY RUN — nothing written' : 'OK'}`);
      console.log(`  suppliers : ${r.suppliersCreated} created, ${r.suppliersExisting} already there`);
      console.log(`  products  : ${r.productsCreated} created, ${r.productsExisting} already there`);
      console.log(`  mappings  : ${r.mappingsWritten} new, ${r.mappingsUpdated} updated`);
      console.log(`  of which placeholder-priced (£${PLACEHOLDER_PRICE.toFixed(2)}): ${r.placeholderPriced}`);
      console.log(`  of which no supplier code (${PLACEHOLDER_SKU}): ${r.placeholderSku} — not orderable until filled in`);
      if (r.unknownProduct.length) {
        console.log(`  ⚠ no product for ${r.unknownProduct.length} SKU(s): ${r.unknownProduct.slice(0, 10).join(', ')}`);
      }
      console.log('');
      console.log('  Placeholder prices are findable later with:');
      console.log(`    SELECT * FROM supplier_products WHERE cost_gbp = ${PLACEHOLDER_PRICE.toFixed(2)};`);
      console.log(`    SELECT * FROM supplier_products WHERE supplier_sku = '${PLACEHOLDER_SKU}';`);
    })
    .catch((err) => {
      console.error('[import-supplier-catalogue] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
