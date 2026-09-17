/**
 * The rules that turn OCR'd invoice lines into product-supplier mappings.
 *
 * Kept apart from the script that runs them because every one of these is a
 * judgement that can be wrong in a way nobody notices: a pack size folded
 * together makes a purchase order the wrong size, a code merged into another
 * loses a product, a unit cost read off the wrong column prices a PO several
 * times over. They are unit-tested against the real spellings observed in
 * three months of Big Bakes invoices.
 */

/** One OCR'd invoice line, as `bumblebee_invoice_purchase_prices` returns it. */
export interface InvoiceLine {
  stock_item: string | null;
  sku: string | null;
  supplier: string | null;
  invoice_date: string | null;
  invoice_number: string | null;
  pack_size: string | null;
  /** kg / L / each, as BumbleBee normalised it. The only unit hint an invoice
   *  carries, and the starting suggestion when a product has to be created. */
  base_unit?: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
  confidence: number | null;
}

/**
 * The ONE code shape that may be treated as a spelling variant: an optional
 * one- or two-letter prefix, an optional space, then digits. Brakes bills the
 * same item as `33891`, `A 33891` and `A33891` — often twice on ONE invoice,
 * same line total, because the OCR read the prefix on one pass and not the
 * other.
 *
 * ⚠️ Deliberately NOT a general "strip the letters" rule. Uncle Roy's sells
 * `20036PR500` and `20036PR1000` — the same essence in a 500ml and a 1L
 * bottle, two genuinely different things to buy. Letters in the MIDDLE fail
 * this pattern, so those are never grouped. Widening it would silently fuse
 * two pack sizes into one mapping and lose whichever lost the merge.
 */
const PREFIXED_CODE = /^([A-Za-z]{0,2}) ?(\d{2,})$/;

/** `(prefix, digits)` for a groupable code, else null. */
export function codeCore(sku: string): { prefix: string; digits: string } | null {
  const m = PREFIXED_CODE.exec(sku.trim());
  return m ? { prefix: m[1]!.toUpperCase(), digits: m[2]! } : null;
}

/**
 * A code that carries no information: `1` is a line number the OCR read as a
 * code, and a run of one repeated digit is usually a misread column rule.
 * Held for review rather than dropped — being wrong here silently loses a real
 * code, and a supplier code nobody can find is indistinguishable from an item
 * nobody buys.
 */
export function isJunkSku(sku: string): boolean {
  return /^(\d)\1*$/.test(sku.trim());
}

/** Unit words that mean the same thing, folded to one spelling. */
const UNIT_WORDS: Array<[RegExp, string]> = [
  [/(?:ltrs?|litres?|liters?)/g, 'l'],
  [/kgs/g, 'kg'],
  [/(?:grams|gms|gm)/g, 'g'],
  [/(?:singles?|units?|ea\b)/g, 'each'],
];

/**
 * Reduce a supplier's pack-size text to something two spellings of the same
 * pack agree on.
 *
 * This matters more than it looks: the pack size is what the reorder engine
 * rounds an order up to, and it is also the evidence that two spellings of a
 * code are the same product. Getting it wrong in either direction is bad —
 * too loose fuses a case of 40 with a single tub, too strict floods the review
 * file with `1x500g` against `500g`.
 *
 * The real spellings this has to reconcile, all observed:
 *   `1 x 1ltr` `1x1ltr` `1X1LTR`   — spacing and case
 *   `1x500g`   `500g`              — an implicit pack of one
 *   `2x5l`     `2x5ltr`            — unit words
 *   `10 Pack`  `1x10`              — "a pack of 10" vs "one case of 10"
 *   `1xEach`   `1x1`               — a single loose item
 * Returns '' when there is nothing to compare, which never counts as a clash.
 */
export function normalisePack(pack: string | null | undefined): string {
  if (!pack) return '';
  let s = String(pack).toLowerCase();
  s = s.replace(/[×*]/g, 'x');
  for (const [re, to] of UNIT_WORDS) s = s.replace(re, to);
  // `10 pack` / `10pk` is a pack OF ten — the same shape as `1x10`.
  s = s.replace(/^(\d+(?:\.\d+)?)\s*(?:pack|pk)\b/, '1x$1');
  s = s.replace(/[^a-z0-9.x]/g, '');
  // A pack of one is the bare size: `1x500g` is `500g`.
  s = s.replace(/^1x(?=\d)/, '');
  // A single loose item, however it was typed.
  if (/^(?:1|each|1xeach|x1)$/.test(s)) return 'each';
  return s;
}

/** Do all these observations agree on the pack? '' abstains rather than clashes. */
export function packsAgree(packs: Array<string | null | undefined>): boolean {
  const seen = new Set(packs.map(normalisePack).filter((p) => p !== ''));
  return seen.size <= 1;
}

export interface UnitCost {
  cost: number | null;
  /** `unit_price` and `line_total / quantity` disagreed; the derived one won. */
  disagreed: boolean;
}

/**
 * What one of these costs.
 *
 * `unit_price` is absent on most OCR passes, so this falls back to
 * `line_total / quantity`. When BOTH are present and disagree, the DERIVED
 * figure wins: the observed failure is the OCR reading a line TOTAL into the
 * unit-price column (32.94 against a real 11.12 on a quantity of 3), and a
 * cost three times over puts that error straight onto a purchase order. The
 * disagreement is reported rather than swallowed.
 */
export function unitCost(line: InvoiceLine): UnitCost {
  const { quantity: q, line_total: lt, unit_price: up } = line;
  const derived = typeof lt === 'number' && typeof q === 'number' && q > 0 ? lt / q : null;
  if (up == null || up <= 0) return { cost: derived, disagreed: false };
  if (derived == null) return { cost: up, disagreed: false };
  // A penny of rounding either way is not a disagreement.
  return Math.abs(up - derived) <= 0.011
    ? { cost: up, disagreed: false }
    : { cost: derived, disagreed: true };
}
