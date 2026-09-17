/**
 * Deciding what to do about a supplier mapping the invoices contradict.
 *
 * `supplier-mapping-audit.ts` finds them; this works out which of exactly two
 * safe shapes each one is, and refuses everything else.
 *
 *   DELETE_SURPLUS  another live mapping for the same code already points at a
 *                   product the invoices AGREE with, so this row is simply
 *                   surplus. Brakes has `11127` -> Caster Sugar beside
 *                   `C 11127` -> Unsalted Butter; the invoices say unsalted
 *                   butter, so the Caster Sugar row goes and nothing is lost.
 *   REPOINT         no correct sibling exists, but a human has already said
 *                   where this code belongs - in the reviewed decisions sheet,
 *                   or in the corrections file - AND that product agrees with
 *                   what the supplier bills. The row moves to it.
 *
 * Anything else is REFUSED and named. In particular a repoint is never made on
 * the invoice description alone: the description says what the goods ARE, not
 * which catalogue row the venue counts them under, and picking that is the
 * judgement this whole pipeline has refused to make since the first extract.
 *
 * WHY DELETE RATHER THAN REPOINT WHEN A SIBLING EXISTS. Repointing would give
 * the target product two mappings for one code - the surviving correct one and
 * this one - and the reorder engine ranks mappings against each other by
 * priority and cost. Two rows for one code is the phantom-buying-option defect
 * migration 0052 exists to prevent. Deleting is the shape that leaves one.
 *
 * THE CORRECTIONS FILE OUTRANKS THE SHEET. The sheet is 431 rows filled in by
 * hand and at least one row slipped - Brakes 10417, "Prepared Baton Carrots",
 * decided as Popcorn. A correction is a human looking at one row and saying
 * so; it wins, and it is committed so the reason travels with it.
 */
import { verdictFor } from './supplier-mapping-audit.js';

export type FixAction = 'DELETE_SURPLUS' | 'REPOINT' | 'REFUSE';

export interface LiveMapping {
  id: string;
  supplier: string;
  supplierSku: string;
  /** Digits of the code, so `11127` and `C 11127` group together. Null when
   *  the code has no digits to core - `NOSKU` and the like, which are left
   *  alone entirely. */
  codeDigits: string | null;
  productId: string;
  productName: string;
  productStockCode: string | null;
}

export interface FixTarget {
  productId: string;
  productName: string;
  stockCode: string | null;
}

export interface FixPlanRow {
  action: FixAction;
  mapping: LiveMapping;
  invoiceDescription: string;
  linesSeen: number;
  /** Where the code is going (REPOINT), or the sibling that made this row
   *  surplus (DELETE_SURPLUS). */
  target?: FixTarget;
  /** Which authority decided it: a correction, the sheet, or a sibling. */
  source?: 'correction' | 'decision-sheet' | 'sibling';
  reason?: string;
}

export interface FixPlan {
  deletes: FixPlanRow[];
  repoints: FixPlanRow[];
  refusals: FixPlanRow[];
}

export interface Contradiction {
  mapping: LiveMapping;
  invoiceDescription: string;
  linesSeen: number;
}

export function planFixes(args: {
  contradictions: Contradiction[];
  /** Every live mapping, so siblings can be found. */
  allMappings: LiveMapping[];
  /** (supplier, sku) -> stock code a human confirmed by hand. Highest authority. */
  corrections: Map<string, string>;
  /** (supplier, sku) -> the product the reviewed decisions sheet named. */
  sheetTargets: Map<string, FixTarget>;
  key: (supplier: string, sku: string) => string;
  /** Stock code -> product, for resolving a correction. */
  byStockCode: Map<string, FixTarget>;
}): FixPlan {
  const { contradictions, allMappings, corrections, sheetTargets, key, byStockCode } = args;
  const plan: FixPlan = { deletes: [], repoints: [], refusals: [] };

  // Siblings are grouped on the code's DIGITS: `11127`, `C 11127` and `C11127`
  // are one Brakes code wearing three spellings.
  const byDigits = new Map<string, LiveMapping[]>();
  for (const m of allMappings) {
    if (!m.codeDigits) continue;
    const k = `${m.supplier.trim().toLowerCase()}\u0000${m.codeDigits}`;
    byDigits.set(k, [...(byDigits.get(k) ?? []), m]);
  }

  // Ids already condemned, so a group of three wrong rows beside one right one
  // cannot have the second wrong row adopt the first as its "correct sibling".
  const condemned = new Set(contradictions.map((c) => c.mapping.id));

  for (const c of contradictions) {
    const { mapping: m } = c;
    const row = (over: Partial<FixPlanRow>): FixPlanRow => ({
      action: 'REFUSE', mapping: m,
      invoiceDescription: c.invoiceDescription, linesSeen: c.linesSeen, ...over,
    });

    // 1. A human looked at this exact row and said where it goes.
    const correctedCode = corrections.get(key(m.supplier, m.supplierSku));
    if (correctedCode) {
      const target = byStockCode.get(correctedCode.trim().toUpperCase());
      if (!target) {
        plan.refusals.push(row({ reason: `correction names stock code "${correctedCode}", which no live product has` }));
        continue;
      }
      if (target.productId === m.productId) {
        plan.refusals.push(row({ reason: 'correction names the product it is already on' }));
        continue;
      }
      plan.repoints.push(row({ action: 'REPOINT', target, source: 'correction' }));
      continue;
    }

    // 2. Is this row simply surplus to a sibling the invoices agree with?
    const siblings = (byDigits.get(`${m.supplier.trim().toLowerCase()}\u0000${m.codeDigits ?? ''}`) ?? [])
      .filter((s) => s.id !== m.id && !condemned.has(s.id));
    const good = siblings.find(
      (s) => s.productId !== m.productId && verdictFor(s.productName, c.invoiceDescription) === 'AGREES',
    );
    if (good) {
      plan.deletes.push(row({
        action: 'DELETE_SURPLUS', source: 'sibling',
        target: { productId: good.productId, productName: good.productName, stockCode: good.productStockCode },
      }));
      continue;
    }

    // 3. The reviewed sheet already named a product for this code.
    const fromSheet = sheetTargets.get(key(m.supplier, m.supplierSku));
    if (!fromSheet) {
      plan.refusals.push(row({ reason: 'no correct sibling, and the decisions sheet does not cover this code' }));
      continue;
    }
    if (fromSheet.productId === m.productId) {
      plan.refusals.push(row({ reason: 'the sheet names the product it is already on - the sheet and the invoices disagree' }));
      continue;
    }
    // The sheet is a human's judgement, but it was filled in 431 rows at a
    // time. Where the invoices flatly contradict it too, that is two
    // independent sources disagreeing and no basis to move anything.
    if (verdictFor(fromSheet.productName, c.invoiceDescription) === 'CONTRADICTS') {
      plan.refusals.push(row({
        reason: `the sheet says "${fromSheet.productName}", which the invoices contradict as well - needs a human`,
      }));
      continue;
    }
    plan.repoints.push(row({ action: 'REPOINT', target: fromSheet, source: 'decision-sheet' }));
  }

  return plan;
}
