/**
 * Check every supplier mapping in the database against the invoices.
 *
 *   npx tsx apps/api/scripts/audit-supplier-mappings.ts
 *   npx tsx apps/api/scripts/audit-supplier-mappings.ts --csv > findings.csv
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * `supplier_products` says "Brakes code 742 is Olives". A year of OCR'd
 * purchase invoices says Brakes bills "Coca-Cola Original Taste Can" under
 * 742. One of those is wrong, and the consequence is not cosmetic: the reorder
 * engine raises a purchase order for whatever the code points at, so a wrong
 * mapping quietly orders the wrong goods and nothing on screen disagrees.
 *
 * WHY IT WAS WRITTEN. The 2026-07-28 `import-supplier-catalogue.ts` run loaded
 * a spreadsheet whose SKU column was out of step with its product column - the
 * same fault documented in the client's key-items workbook, where code 26089
 * sat against "Brakes Med Eggs (Shell On) 15Dozen" while 66 invoice lines call
 * it "Vinyl Gloves Clear Lge PF GD09L". Sixteen of those rows surfaced when
 * the reviewed decisions were applied, because the importer refuses to put one
 * code on two products. That was sixteen out of however many - this counts the
 * rest.
 *
 * WHAT IT REPORTS, in the order it matters:
 *
 *   CONTRADICTS     the mapped product and the invoice description share not
 *                   one significant word. Ranked by invoice lines, so the
 *                   codes the venues actually buy come first.
 *   one code, two   the same supplier code on two products. Whichever is
 *   products        right, the other is ordering the wrong thing.
 *   spelling groups `149492` / `A 149492` / `A149492` as three separate
 *                   purchasable lines. Where they agree on the product this is
 *                   a mechanical fix (fold the extras into aliases, migration
 *                   0052); where they disagree it is a judgement.
 *   PLAUSIBLE       shares something but not much. Reported last and only with
 *                   --verbose: a venue name shorter than the supplier's
 *                   ("Milk" vs "Arla UHT Whole Milk") lands here and is
 *                   usually fine. Flagging those would bury the real signal.
 *
 * IT DOES NOT FIX ANYTHING, deliberately. Which of two products a code belongs
 * to is a judgement - the invoices are strong evidence, not a verdict, because
 * OCR misreads and a supplier can genuinely retire and reuse a code. The
 * findings go to a human, in the same spirit as the match-review file.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, supplierProducts, suppliers } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { normaliseSku } from '../src/modules/suppliers/supplier-sku-resolver.js';
import {
  auditMappings,
  type Finding,
  type InvoiceFact,
  type MappingRow,
} from '../src/modules/suppliers/supplier-mapping-audit.js';
import { readSkuCsv } from './import-invoice-skus.js';
import { toCsv } from '../src/shared/utils/csv.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'invoice-skus');

const key = (supplier: string, sku: string) => `${supplier.trim().toLowerCase()}\u0000${normaliseSku(sku)}`;

export async function runAudit(opts: { skusFile?: string; companyId?: string } = {}) {
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const db = getDb();

  // What the invoices say. Aliases count too: a mapping whose CANONICAL code
  // is a spelling variant still has to be judged against the right line.
  const invoiceFacts = new Map<string, InvoiceFact>();
  for (const row of readSkuCsv(readFileSync(opts.skusFile ?? join(DATA_DIR, 'supplier-skus.csv'), 'utf8'))) {
    const fact = { description: row.description, linesSeen: row.linesSeen };
    invoiceFacts.set(key(row.supplier, row.supplierSku), fact);
    for (const alias of row.aliases) invoiceFacts.set(key(row.supplier, alias), fact);
  }

  const rows: MappingRow[] = (
    await db
      .select({
        supplier: suppliers.name,
        supplierSku: supplierProducts.supplierSku,
        productName: products.name,
        productStockCode: products.stockCode,
        createdAt: supplierProducts.createdAt,
      })
      .from(supplierProducts)
      .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
      .innerJoin(products, eq(products.id, supplierProducts.productId))
      .where(and(eq(supplierProducts.companyId, companyId), isNull(supplierProducts.deletedAt)))
  ).map((r) => ({
    supplier: r.supplier,
    supplierSku: r.supplierSku,
    productName: r.productName,
    productStockCode: r.productStockCode,
    createdOn: (r.createdAt ?? new Date()).toISOString().slice(0, 10),
  }));

  return { report: auditMappings(rows, invoiceFacts, key), total: rows.length };
}

const isCliEntry = process.argv[1]?.endsWith('audit-supplier-mappings.ts') ?? false;

if (isCliEntry) {
  const asCsv = process.argv.includes('--csv');
  const verbose = process.argv.includes('--verbose');

  runAudit()
    .then(({ report: r, total }) => {
      if (asCsv) {
        // One row per finding, for a spreadsheet: the same review loop as
        // match-review.csv, with a decision column for a human to fill in.
        // `toCsv` guards against spreadsheet formula injection - a supplier
        // code can start with a character Excel would run.
        console.log(
          toCsv<Finding & { decision: string }>(
            [
              { header: 'verdict', value: (f) => f.verdict },
              { header: 'supplier', value: (f) => f.supplier },
              { header: 'supplier_sku', value: (f) => f.supplierSku },
              { header: 'mapped_product', value: (f) => f.productName },
              { header: 'mapped_stock_code', value: (f) => f.productStockCode ?? '' },
              { header: 'invoices_say', value: (f) => f.invoiceDescription },
              { header: 'lines_seen', value: (f) => f.linesSeen },
              { header: 'mapping_created', value: (f) => f.createdOn },
              // Ships empty, like match-review.csv. Nothing here pre-commits a
              // judgement the invoices cannot make.
              { header: 'decision', value: (f) => f.decision },
            ],
            [...r.contradicts, ...(verbose ? r.plausible : [])].map((f) => ({ ...f, decision: '' })),
          ),
        );
        return;
      }

      console.log('[audit-supplier-mappings] READ-ONLY - nothing was changed\n');
      console.log(`  supplier mappings      : ${total}`);
      console.log(`  checkable against invoices: ${r.checked}`);
      console.log(`  no invoice evidence    : ${r.noEvidence}  (nothing to say about these)`);
      console.log(`  look right             : ${r.agrees}`);
      console.log(`  WRONG (contradicted)   : ${r.contradicts.length}`);
      console.log(`  worth a look           : ${r.plausible.length}`);

      if (r.contradicts.length > 0) {
        console.log(`\n  ${r.contradicts.length} mapping(s) the invoices CONTRADICT.`);
        console.log('  Not one word in common between the product and what the supplier bills.');
        console.log('  Most-invoiced first - these are the ones a reorder would get wrong:\n');
        for (const f of r.contradicts) {
          console.log(`    ${String(f.linesSeen).padStart(4)} lines  ${f.supplier} ${f.supplierSku}   (mapped ${f.createdOn})`);
          console.log(`                mapped to : ${f.productName} [${f.productStockCode ?? 'no code'}]`);
          console.log(`                invoices  : ${f.invoiceDescription}`);
        }
      }

      if (r.duplicateCodes.length > 0) {
        console.log(`\n  ${r.duplicateCodes.length} code(s) on MORE THAN ONE product:`);
        for (const d of r.duplicateCodes) {
          console.log(`    ${d.supplier} ${d.supplierSku}`);
          for (const p of d.products) console.log(`        ${p.name} [${p.stockCode ?? 'no code'}]`);
        }
      }

      if (r.spellingGroups.length > 0) {
        const mechanical = r.spellingGroups.filter((g) => g.sameProduct);
        const judgement = r.spellingGroups.filter((g) => !g.sameProduct);
        console.log(`\n  ${r.spellingGroups.length} supplier code(s) filed as SEVERAL purchasable lines.`);
        console.log('  These are spellings of one code, and the reorder engine ranks them');
        console.log('  against each other - so a phantom can win the order. They belong in');
        console.log('  supplier_product_aliases (migration 0052), not here.');
        console.log(`    ${mechanical.length} where every spelling agrees on the product (a mechanical fix)`);
        console.log(`    ${judgement.length} where they DISAGREE (a judgement - listed below)`);
        for (const g of judgement) {
          console.log(`\n    ${g.supplier} code ${g.digits}:`);
          for (const s of g.spellings) console.log(`        ${s.sku.padEnd(14)} -> ${s.productName} [${s.stockCode ?? 'no code'}]`);
        }
        if (verbose) {
          for (const g of mechanical) {
            console.log(`\n    ${g.supplier} ${g.digits} -> ${g.spellings[0]!.productName}`);
            console.log(`        spellings: ${g.spellings.map((s) => s.sku).join(', ')}`);
          }
        }
      }

      if (verbose && r.plausible.length > 0) {
        console.log(`\n  ${r.plausible.length} worth a look (share something, but not much):`);
        for (const f of r.plausible.slice(0, 40)) {
          console.log(`    ${String(f.linesSeen).padStart(4)} lines  ${f.supplier} ${f.supplierSku}`);
          console.log(`                mapped to : ${f.productName}`);
          console.log(`                invoices  : ${f.invoiceDescription}`);
        }
        if (r.plausible.length > 40) console.log(`    ... and ${r.plausible.length - 40} more`);
      }

      console.log('\n  Nothing here was changed. Re-run with --csv > findings.csv for a');
      console.log('  spreadsheet with a decision column, or --verbose for the full detail.');
    })
    .catch((err) => {
      console.error('[audit-supplier-mappings] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
