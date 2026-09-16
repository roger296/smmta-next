import { uomFullName } from '@/lib/uom';

/**
 * What the counter is told to do with an item, on the stock-take row.
 *
 * Replaces the old "Book: 0 kg" sub-line (Sept-2026 request). Two reasons that
 * line was the wrong thing to show:
 *
 * - It answered a question nobody counting has. "What does the system think we
 *   have" is head office's question; the counter's is "what am I counting this
 *   in — do I weigh it, or count boxes?" The stock unit was in there, but as a
 *   two-letter token at the end of a number.
 * - Showing the book figure **before** the count invites anchoring. A counter
 *   who can see "Book: 40 kg" has been told the answer, and a count that agrees
 *   with the ledger is worth nothing. The variance badge still appears once a
 *   number is entered, which is when the comparison is actually useful.
 */

/**
 * The line a counter reads under the product name.
 *
 * The per-product instruction wins whenever it is set — head office wrote it
 * BECAUSE the generic sentence was not enough for that item. Otherwise the
 * sentence is built from the stock unit. When the unit is unknown too there is
 * nothing honest to say, so it returns null and the row shows no message rather
 * than "Count this item in ".
 */
export function countInstruction(
  instruction: string | null | undefined,
  stockUom: string | null | undefined,
): string | null {
  const own = (instruction ?? '').trim();
  if (own) return own;
  const unit = uomFullName(stockUom);
  return unit ? `Count this item in ${unit}` : null;
}
