/**
 * Repair the supplier mappings the invoices contradict.
 *
 *   npx tsx apps/api/scripts/fix-supplier-mappings.ts            # DRY RUN
 *   npx tsx apps/api/scripts/fix-supplier-mappings.ts --apply
 *
 * Dry-run by default. `--apply` is the only thing that writes.
 *
 * `audit-supplier-mappings.ts` finds the rows where what the database says a
 * supplier code means and what a year of invoices says it means share not one
 * word. This fixes the ones that can be fixed without a judgement, and refuses
 * the rest by name. The rules live in
 * `modules/suppliers/supplier-mapping-fix.ts`; the two shapes are:
 *
 *   DELETE_SURPLUS  a sibling spelling of the same code already points at the
 *                   right product, so this row is surplus
 *   REPOINT         nothing else has it right, but the reviewed decisions
 *                   sheet or the corrections file names the product, and the
 *                   invoices agree with that product
 *
 * THE DELETE IS A SOFT DELETE, and that is sufficient rather than merely
 * tidy: every reader of `supplier_products` filters `deleted_at IS NULL`,
 * including `modules/stock/supplier-products.ts`, which is what ranks buying
 * options for a reorder. A soft-deleted row stops competing for the order.
 *
 * IT ALSO SOFT-DELETES THAT ROW'S ALIASES. `aliasConflict` checks whether a
 * spelling is already taken WITHOUT looking at whether the mapping owning it
 * is deleted, so aliases left behind would keep blocking the surviving correct
 * mapping from claiming those spellings - a dead row reaching out of the grave
 * to stop the live one working.
 *
 * WHAT IT WILL NOT TOUCH:
 *   - `NOSKU` and other codes with no digits. ~95 rows carry that placeholder
 *     where the July 2026 import had no code at all. They are inert, the owner
 *     has asked to keep them, and they cannot be grouped or resolved anyway.
 *   - anything in the audit's PLAUSIBLE tier. Those share words with the
 *     invoice and are usually a venue name shorter than the supplier's.
 *   - a row where the sheet and the invoices disagree with each other. Two
 *     independent sources contradicting one product is no basis to pick a
 *     third.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { parse as csvParse } from 'csv-parse/sync';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, supplierProductAliases, supplierProducts, suppliers } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { normaliseSku } from '../src/modules/suppliers/supplier-sku-resolver.js';
import { codeCore } from '../src/modules/suppliers/invoice-sku-extract.js';
import {
  auditMappings,
  type InvoiceFact,
  type MappingRow,
} from '../src/modules/suppliers/supplier-mapping-audit.js';
import {
  planFixes,
  type Contradiction,
  type FixPlan,
  type FixTarget,
  type LiveMapping,
} from '../src/modules/suppliers/supplier-mapping-fix.js';
import { readSkuCsv, readDecisionCsv } from './import-invoice-skus.js';
import {
  classifyDecision,
  normaliseName as normaliseDecisionName,
} from '../src/modules/suppliers/invoice-sku-decisions.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'invoice-skus');

const key = (supplier: string, sku: string) => `${supplier.trim().toLowerCase()}\u0000${normaliseSku(sku)}`;

export interface CorrectionRow {
  supplier: string;
  supplierSku: string;
  stockCode: string;
  why: string;
}

export function readCorrectionsCsv(text: string): CorrectionRow[] {
  const records = csvParse(text, { columns: true, skip_empty_lines: true, bom: true }) as Array<
    Record<string, string>
  >;
  return records
    .map((r) => ({
      supplier: (r.supplier ?? '').trim(),
      supplierSku: (r.supplier_sku ?? '').trim().replace(/^'/, ''),
      stockCode: (r.stock_code ?? '').trim(),
      why: (r.why ?? '').trim(),
    }))
    .filter((r) => r.supplier && r.supplierSku && r.stockCode);
}

export interface FixReport extends FixPlan {
  deleted: number;
  repointed: number;
  aliasesRetired: number;
  dryRun: boolean;
}

export async function fixSupplierMappings(
  opts: {
    apply?: boolean;
    skusFile?: string;
    decisionsFile?: string;
    correctionsFile?: string;
    companyId?: string;
  } = {},
): Promise<FixReport> {
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const db = getDb();
  const apply = opts.apply ?? false;

  // What the invoices say each code is.
  const invoiceFacts = new Map<string, InvoiceFact>();
  for (const row of readSkuCsv(readFileSync(opts.skusFile ?? join(DATA_DIR, 'supplier-skus.csv'), 'utf8'))) {
    const fact = { description: row.description, linesSeen: row.linesSeen };
    invoiceFacts.set(key(row.supplier, row.supplierSku), fact);
    for (const alias of row.aliases) invoiceFacts.set(key(row.supplier, alias), fact);
  }

  const liveProducts = await db
    .select({ id: products.id, name: products.name, stockCode: products.stockCode })
    .from(products)
    .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));
  const byStockCode = new Map<string, FixTarget>();
  const byName = new Map<string, FixTarget | null>();
  for (const p of liveProducts) {
    const t: FixTarget = { productId: p.id, productName: p.name, stockCode: p.stockCode };
    if (p.stockCode) byStockCode.set(p.stockCode.trim().toUpperCase(), t);
    const n = normaliseDecisionName(p.name);
    if (!n) continue;
    // A name two live products share identifies neither.
    byName.set(n, byName.has(n) ? null : t);
  }

  // Where the reviewed sheet said each code belongs. `ADD ITEM` rows resolve
  // through the product that run created, by name.
  const sheetTargets = new Map<string, FixTarget>();
  for (const d of readDecisionCsv(
    readFileSync(opts.decisionsFile ?? join(DATA_DIR, 'match-review-decided.csv'), 'utf8'),
  )) {
    const { kind, stockCode } = classifyDecision(d.decision);
    let target: FixTarget | null | undefined;
    if (kind === 'ACCEPT') target = byStockCode.get(d.proposedStockCode.trim().toUpperCase());
    else if (kind === 'STOCK_CODE') target = byStockCode.get((stockCode ?? '').trim().toUpperCase());
    else if (kind === 'ADD') target = byName.get(normaliseDecisionName(d.newProductName));
    if (target) sheetTargets.set(key(d.supplier, d.supplierSku), target);
  }

  const corrections = new Map<string, string>();
  const correctionRows = readCorrectionsCsv(
    readFileSync(opts.correctionsFile ?? join(DATA_DIR, 'mapping-corrections.csv'), 'utf8'),
  );
  for (const c of correctionRows) corrections.set(key(c.supplier, c.supplierSku), c.stockCode);

  const raw = await db
    .select({
      id: supplierProducts.id,
      supplier: suppliers.name,
      supplierSku: supplierProducts.supplierSku,
      productId: products.id,
      productName: products.name,
      productStockCode: products.stockCode,
      createdAt: supplierProducts.createdAt,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .innerJoin(products, eq(products.id, supplierProducts.productId))
    .where(and(eq(supplierProducts.companyId, companyId), isNull(supplierProducts.deletedAt)));

  const allMappings: LiveMapping[] = raw.map((r) => ({
    id: r.id,
    supplier: r.supplier,
    supplierSku: r.supplierSku,
    codeDigits: codeCore(r.supplierSku)?.digits ?? null,
    productId: r.productId,
    productName: r.productName,
    productStockCode: r.productStockCode,
  }));

  // Re-run the audit here rather than taking a findings file: the fix must act
  // on the database as it is NOW, not as it was when somebody ran the report.
  const auditRows: MappingRow[] = raw.map((r) => ({
    supplier: r.supplier,
    supplierSku: r.supplierSku,
    productName: r.productName,
    productStockCode: r.productStockCode,
    createdOn: (r.createdAt ?? new Date()).toISOString().slice(0, 10),
  }));
  const audit = auditMappings(auditRows, invoiceFacts, key);

  // The audit reports findings, not row ids, so match each one back to the
  // mapping it came from. The identity is (supplier, code, product) - the same
  // triple the audit printed - and a stock code identifies the product more
  // reliably than a name two products could share.
  const findingKey = (supplier: string, sku: string, stockCode: string | null, name: string) =>
    `${key(supplier, sku)}\u0000${stockCode ? stockCode.trim().toUpperCase() : `name:${name.trim().toLowerCase()}`}`;
  const byFinding = new Map<string, LiveMapping[]>();
  for (const m of allMappings) {
    const k = findingKey(m.supplier, m.supplierSku, m.productStockCode, m.productName);
    byFinding.set(k, [...(byFinding.get(k) ?? []), m]);
  }
  const contradictions: Contradiction[] = [];
  for (const f of audit.contradicts) {
    const matched = byFinding.get(findingKey(f.supplier, f.supplierSku, f.productStockCode, f.productName)) ?? [];
    for (const m of matched) {
      contradictions.push({ mapping: m, invoiceDescription: f.invoiceDescription, linesSeen: f.linesSeen });
    }
  }

  const plan = planFixes({ contradictions, allMappings, corrections, sheetTargets, key, byStockCode });
  const report: FixReport = { ...plan, deleted: 0, repointed: 0, aliasesRetired: 0, dryRun: !apply };

  if (!apply) {
    report.deleted = plan.deletes.length;
    report.repointed = plan.repoints.length;
    return report;
  }

  // One transaction: a half-applied repair leaves the catalogue in a state
  // nobody planned and nobody can read off a report.
  await db.transaction(async (tx) => {
    const now = new Date();
    for (const d of plan.deletes) {
      await tx.update(supplierProducts).set({ deletedAt: now, updatedAt: now })
        .where(eq(supplierProducts.id, d.mapping.id));
      // See the header: an alias outliving its mapping keeps blocking the
      // surviving correct one from claiming that spelling.
      const retired = await tx.update(supplierProductAliases)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(
          eq(supplierProductAliases.supplierProductId, d.mapping.id),
          isNull(supplierProductAliases.deletedAt),
        ))
        .returning({ id: supplierProductAliases.id });
      report.aliasesRetired += retired.length;
      report.deleted += 1;
    }
    for (const r of plan.repoints) {
      await tx.update(supplierProducts)
        .set({ productId: r.target!.productId, updatedAt: now })
        .where(eq(supplierProducts.id, r.mapping.id));
      report.repointed += 1;
    }
  });

  return report;
}

const isCliEntry = process.argv[1]?.endsWith('fix-supplier-mappings.ts') ?? false;

if (isCliEntry) {
  const apply = process.argv.includes('--apply');

  fixSupplierMappings({ apply })
    .then((r) => {
      console.log(`[fix-supplier-mappings] ${r.dryRun ? 'DRY RUN - nothing written' : 'APPLIED'}\n`);
      console.log(`  rows deleted as surplus : ${r.deleted}`);
      console.log(`  rows repointed          : ${r.repointed}`);
      if (!r.dryRun) console.log(`  aliases retired with them: ${r.aliasesRetired}`);
      console.log(`  refused                 : ${r.refusals.length}`);

      if (r.deletes.length > 0) {
        console.log(`\n  ${r.deletes.length} SURPLUS row(s) - a sibling spelling of the same code`);
        console.log('  already points at the product the invoices name, so nothing is lost:\n');
        for (const d of r.deletes) {
          console.log(`    ${String(d.linesSeen).padStart(4)} lines  ${d.mapping.supplier} ${d.mapping.supplierSku}`);
          console.log(`                remove from : ${d.mapping.productName} [${d.mapping.productStockCode ?? 'no code'}]`);
          console.log(`                stays on    : ${d.target!.productName} [${d.target!.stockCode ?? 'no code'}]`);
          console.log(`                invoices    : ${d.invoiceDescription}`);
        }
      }

      if (r.repoints.length > 0) {
        console.log(`\n  ${r.repoints.length} row(s) to REPOINT - no sibling has it right, and a human`);
        console.log('  already named the product:\n');
        for (const p of r.repoints) {
          console.log(`    ${String(p.linesSeen).padStart(4)} lines  ${p.mapping.supplier} ${p.mapping.supplierSku}   (per ${p.source})`);
          console.log(`                from     : ${p.mapping.productName} [${p.mapping.productStockCode ?? 'no code'}]`);
          console.log(`                to       : ${p.target!.productName} [${p.target!.stockCode ?? 'no code'}]`);
          console.log(`                invoices : ${p.invoiceDescription}`);
        }
      }

      if (r.refusals.length > 0) {
        console.log(`\n  ${r.refusals.length} REFUSED - left exactly as they are:\n`);
        for (const f of r.refusals) {
          console.log(`    ${String(f.linesSeen).padStart(4)} lines  ${f.mapping.supplier} ${f.mapping.supplierSku}`);
          console.log(`                on       : ${f.mapping.productName} [${f.mapping.productStockCode ?? 'no code'}]`);
          console.log(`                invoices : ${f.invoiceDescription}`);
          console.log(`                why      : ${f.reason}`);
        }
        console.log('\n  Add a row to apps/api/data/invoice-skus/mapping-corrections.csv to');
        console.log('  settle one of these, then re-run. A correction outranks everything.');
      }

      if (r.dryRun) console.log('\n  Nothing was written. Re-run with --apply.');
    })
    .catch((err) => {
      console.error('[fix-supplier-mappings] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
