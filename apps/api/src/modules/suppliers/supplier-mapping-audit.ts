/**
 * Checking the supplier mappings already in the database against the invoices.
 *
 * `supplier_products` says "Brakes code 742 is Coca-Cola". A year of OCR'd
 * purchase invoices says what Brakes actually bills under 742. When those two
 * disagree the mapping is wrong, and a wrong mapping is invisible: the reorder
 * engine raises a purchase order for whatever the code points at, and nothing
 * on screen says the code means something else.
 *
 * WHY THIS EXISTS. The 2026-07-28 `import-supplier-catalogue.ts` run loaded a
 * spreadsheet whose SKU column was pasted out of step with its product column
 * - the same fault found in the client's own key-items workbook, where code
 * 26089 sat against "Brakes Med Eggs (Shell On) 15Dozen" while 66 invoice
 * lines call it "Vinyl Gloves Clear Lge PF GD09L". A handful of those rows
 * were caught when the reviewed decisions were applied, because the importer
 * refused to put one code on two products. The rest are still there.
 *
 * NOTHING HERE WRITES. It ranks disagreements by how much invoice evidence
 * sits behind each one, and a human decides. Which of two products a code
 * belongs to is a judgement — the invoices are strong evidence, not a verdict,
 * because OCR misreads and a supplier can genuinely recycle a code.
 */
import { significantTokens } from './invoice-sku-match.js';
import { codeCore } from './invoice-sku-extract.js';

export type Verdict = 'AGREES' | 'PLAUSIBLE' | 'CONTRADICTS';

/**
 * Does the mapped product look like what the supplier bills under this code?
 *
 * Deliberately NOT `coverage()` from the matcher. That returns 0 both for
 * "shares nothing" and for "shares most of it but not all" - which is right
 * when proposing a match (a partial overlap is a different product, not a
 * weaker one) and useless here, where the whole question is HOW wrong a row
 * is. "Caster Sugar" against "Noble Free Range Liquid Egg White" and "Milk"
 * against "Arla UHT Whole Milk" both score 0 there; only one of them is a
 * defect.
 *
 * So this is symmetric and three-valued:
 *
 *   AGREES      the product's words account for a real share of the
 *               description - this is the ordinary, correct case
 *   PLAUSIBLE   they share something but not enough to be sure. A venue name
 *               that is shorter or differently worded than the supplier's
 *               ("Milk" vs "Arla UHT Whole Milk") lands here, and so does a
 *               near miss worth a human's eye.
 *   CONTRADICTS not one significant word in common. Coca-Cola is not olives.
 *
 * Only CONTRADICTS is treated as a finding. PLAUSIBLE is reported separately
 * and quietly: flagging every short venue name would bury the real signal
 * under the catalogue's own naming style.
 */
export function verdictFor(productName: string, invoiceDescription: string): Verdict {
  const prod = significantTokens(productName);
  const desc = significantTokens(invoiceDescription);
  // Nothing to judge with. Not evidence of a defect - a description of "1kg"
  // or a product named only with a code leaves no words to compare.
  if (prod.size === 0 || desc.size === 0) return 'PLAUSIBLE';

  let shared = 0;
  for (const t of prod) if (desc.has(t)) shared += 1;
  if (shared === 0) return 'CONTRADICTS';
  // Measured against the DESCRIPTION, as the matcher does: a two-word venue
  // name explaining two of six supplier words is a good mapping, not a weak
  // one.
  return shared / desc.size >= 0.3 ? 'AGREES' : 'PLAUSIBLE';
}

export interface MappingRow {
  supplier: string;
  supplierSku: string;
  productName: string;
  productStockCode: string | null;
  createdOn: string;
}

export interface InvoiceFact {
  description: string;
  linesSeen: number;
}

export interface Finding extends MappingRow {
  invoiceDescription: string;
  linesSeen: number;
  verdict: Verdict;
}

export interface DuplicateCode {
  supplier: string;
  supplierSku: string;
  products: Array<{ name: string; stockCode: string | null }>;
}

export interface SpellingGroup {
  supplier: string;
  digits: string;
  /** Each row that is its own canonical line for what is one supplier code. */
  spellings: Array<{ sku: string; productName: string; stockCode: string | null }>;
  /** True when they at least all point at the same product - then the fix is
   *  purely "fold the extras into aliases", with no judgement needed. */
  sameProduct: boolean;
}

export interface AuditReport {
  checked: number;
  /** No invoice line in the extract carries this code, so nothing to say. */
  noEvidence: number;
  agrees: number;
  plausible: Finding[];
  contradicts: Finding[];
  duplicateCodes: DuplicateCode[];
  spellingGroups: SpellingGroup[];
}

export function auditMappings(
  rows: MappingRow[],
  invoiceFacts: Map<string, InvoiceFact>,
  key: (supplier: string, sku: string) => string,
): AuditReport {
  const report: AuditReport = {
    checked: 0, noEvidence: 0, agrees: 0,
    plausible: [], contradicts: [], duplicateCodes: [], spellingGroups: [],
  };

  for (const row of rows) {
    const fact = invoiceFacts.get(key(row.supplier, row.supplierSku));
    if (!fact) { report.noEvidence += 1; continue; }
    report.checked += 1;
    const verdict = verdictFor(row.productName, fact.description);
    const finding: Finding = {
      ...row, invoiceDescription: fact.description, linesSeen: fact.linesSeen, verdict,
    };
    if (verdict === 'AGREES') report.agrees += 1;
    else if (verdict === 'PLAUSIBLE') report.plausible.push(finding);
    else report.contradicts.push(finding);
  }

  // One code on two products. Whichever is right, the other is raising orders
  // for the wrong goods.
  const byCode = new Map<string, MappingRow[]>();
  for (const row of rows) {
    const k = key(row.supplier, row.supplierSku);
    byCode.set(k, [...(byCode.get(k) ?? []), row]);
  }
  for (const group of byCode.values()) {
    const distinct = new Map(group.map((g) => [g.productStockCode ?? g.productName, g]));
    if (distinct.size < 2) continue;
    report.duplicateCodes.push({
      supplier: group[0]!.supplier,
      supplierSku: group[0]!.supplierSku,
      products: [...distinct.values()].map((g) => ({ name: g.productName, stockCode: g.productStockCode })),
    });
  }

  // Spelling variants sitting as separate canonical lines - `149492`,
  // `A 149492`, `A149492`. Grouped on the DIGITS, which is what survives the
  // prefix a depot adds. These are buying options as far as the reorder engine
  // is concerned, so the extras can win an order.
  const byDigits = new Map<string, MappingRow[]>();
  for (const row of rows) {
    const core = codeCore(row.supplierSku);
    if (!core) continue;
    const k = `${row.supplier.toLowerCase()}\u0000${core.digits}`;
    byDigits.set(k, [...(byDigits.get(k) ?? []), row]);
  }
  for (const group of byDigits.values()) {
    if (group.length < 2) continue;
    const products = new Set(group.map((g) => g.productStockCode ?? g.productName));
    report.spellingGroups.push({
      supplier: group[0]!.supplier,
      digits: codeCore(group[0]!.supplierSku)!.digits,
      spellings: group.map((g) => ({
        sku: g.supplierSku, productName: g.productName, stockCode: g.productStockCode,
      })),
      sameProduct: products.size === 1,
    });
  }

  // Most invoice evidence first: the work list, heaviest-used codes at the top.
  report.contradicts.sort((a, b) => b.linesSeen - a.linesSeen);
  report.plausible.sort((a, b) => b.linesSeen - a.linesSeen);
  report.spellingGroups.sort((a, b) => b.spellings.length - a.spellings.length);
  return report;
}
