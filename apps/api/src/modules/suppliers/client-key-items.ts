/**
 * The client's own list of what the stock system should hold.
 *
 * Rebecca's workbook names, per supplier line, the product Big Bakes actually
 * wants it to be — `Suggested name` against a `Stock item` description lifted
 * from the OCR'd invoices, with a SKU, a supplier and a Group ID beside it. It
 * is the closest thing to an answer key this whole exercise has, and it beats
 * any amount of string matching.
 *
 * ⚠️ BUT ITS SKU COLUMN CANNOT BE TRUSTED ON ITS OWN. Cross-checked against the
 * invoice lines the codes came from, 57 of 617 rows name a SKU whose real
 * description is nothing like the one sitting next to it:
 *
 *     SKU 135575  sheet says "Brakes Med Eggs (Shell On)"
 *                 invoices say "Noble Free Range Liquid Egg White" (123 lines)
 *     SKU 26089   sheet says "Brakes Med Eggs (Shell On) 15Dozen"
 *                 invoices say "Vinyl Gloves Clear Lge PF GD09L" (66 lines)
 *
 * 24 SKUs appear against two or more different products. The shape of it — one
 * code repeating under unrelated items — is a column pasted a few rows out of
 * step, not a judgement anybody made. Taking those at face value would weld a
 * supplier code for gloves onto a box of eggs.
 *
 * So a row's SKU is used only when the row's own DESCRIPTION agrees with what
 * the invoices say that SKU is. Where they disagree the description wins —
 * that is what the client was looking at when they wrote the name — and the
 * SKU is discarded for that row and reported.
 */

export interface ClientKeyItem {
  /** What Big Bakes wants the product called. */
  suggestedName: string;
  /** The invoice-line text the client was looking at. */
  stockItem: string;
  category: string;
  groupId: string;
  sku: string;
  supplier: string;
  packSize: string;
  /** Which tab it came from; `Phase 1` is the priority set. */
  sheet: string;
}

export interface ValidatedItem extends ClientKeyItem {
  /**
   * 'sku-and-description' — the code and the text agree with the invoices; the
   *   strongest evidence available, and safe to key on.
   * 'description-only'   — no invoice line for this code, so the name stands on
   *   the description alone.
   * 'sku-mismatched'     — the invoices say this code is something else. The
   *   SKU is dropped; the description still carries the name.
   */
  trust: 'sku-and-description' | 'description-only' | 'sku-mismatched';
  /** What the invoices say the SKU is, when that disagrees. For the report. */
  invoiceSaysInstead?: string;
}

/** Words worth comparing: no punctuation, nothing tiny. */
export function descriptionTokens(text: string): Set<string> {
  // A row's description often carries its own code — "C 135575 - Noble Free
  // Range Liquid Egg White" — which would match any description and must not
  // count as agreement.
  const withoutLeadingCode = text.replace(/^[A-Za-z]{0,2}\s?\d{2,}\s*-\s*/, '');
  return new Set(
    withoutLeadingCode
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 2),
  );
}

/**
 * Do two descriptions of the same goods agree?
 *
 * Measured against the SHORTER of the two, because the client abbreviates —
 * "Brake Esse Tom & Cheese Quiche" against the invoice's "Brakes Essentials
 * Fully Baked Tomato & Cheese Quiche Slabs" is the same thing, and a symmetric
 * measure calls it a conflict.
 */
export function descriptionsAgree(a: string, b: string, threshold = 0.5): boolean {
  const ta = descriptionTokens(a);
  const tb = descriptionTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (matchesAny(t, tb)) shared += 1;
  return shared / Math.min(ta.size, tb.size) >= threshold;
}

/**
 * The client abbreviates INSIDE words, not just by dropping them: `Brake` for
 * Brakes, `Esse` for Essentials, `Tom` for Tomato. Whole-token equality reads
 * "Brake Esse Tom & Cheese Quiche" and "Brakes Essentials Fully Baked Tomato &
 * Cheese Quiche Slabs" as a conflict, which is plainly wrong and would throw
 * away a good row.
 *
 * So a token counts when either is a prefix of the other, at four characters or
 * more. Four rather than three because `car` opens both carrot and cardboard,
 * and a wrong agreement here lets a mismatched SKU through as corroborated —
 * the one thing this module exists to catch.
 */
function matchesAny(token: string, others: Set<string>): boolean {
  if (others.has(token)) return true;
  if (token.length < 4) return false;
  for (const o of others) {
    if (o.length >= 4 && (o.startsWith(token) || token.startsWith(o))) return true;
  }
  return false;
}

/** Trimmed, lower-cased, punctuation removed — how codes are compared. */
export function normaliseCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * Check every row's SKU against what the invoices say that code actually is.
 *
 * `invoiceDescriptionByCode` should carry canonical codes AND their aliases,
 * since the client writes `A 10678` where the invoice run settled on `10678`.
 */
export function validate(
  items: ClientKeyItem[],
  invoiceDescriptionByCode: Map<string, string>,
): ValidatedItem[] {
  return items.map((item) => {
    const code = normaliseCode(item.sku);
    const invoiceSays = code ? invoiceDescriptionByCode.get(code) : undefined;
    if (!code || invoiceSays === undefined) return { ...item, trust: 'description-only' };
    if (descriptionsAgree(item.stockItem, invoiceSays)) {
      return { ...item, trust: 'sku-and-description' };
    }
    return { ...item, trust: 'sku-mismatched', invoiceSaysInstead: invoiceSays };
  });
}

/**
 * The name the client wants for a given supplier code — only from rows whose
 * SKU the invoices corroborate.
 *
 * A code the client mapped to two DIFFERENT names is dropped rather than
 * resolved: that is the misalignment showing through, and picking one would be
 * guessing which row was pasted correctly.
 */
export function nameByCode(items: ValidatedItem[]): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const i of items) {
    if (i.trust !== 'sku-and-description') continue;
    const code = normaliseCode(i.sku);
    const name = i.suggestedName.trim();
    if (!code || !name) continue;
    const at = candidates.get(code);
    if (at) at.add(name);
    else candidates.set(code, new Set([name]));
  }
  const out = new Map<string, string>();
  for (const [code, names] of candidates) {
    if (names.size === 1) out.set(code, [...names][0]!);
  }
  return out;
}

/** The name the client wants for a given invoice DESCRIPTION. The fallback when
 *  the SKU is missing or contradicted, and the only axis the misaligned rows
 *  still support. */
export function nameByDescription(items: ValidatedItem[]): Array<{ tokens: Set<string>; name: string }> {
  const seen = new Map<string, string>();
  for (const i of items) {
    const name = i.suggestedName.trim();
    if (!name || !i.stockItem) continue;
    const key = [...descriptionTokens(i.stockItem)].sort().join(' ');
    if (!key) continue;
    // First writing wins; the sheets repeat the same pairing many times.
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen].map(([key, name]) => ({ tokens: new Set(key.split(' ')), name }));
}
