/**
 * Unit-of-measure labels for the counting screen.
 *
 * The catalogue stores the stock system's own codes (`kg`, `l`, `each`) because
 * that is what the valuation and the ledger use. Those codes are fine in a
 * database and poor on a shelf: "l" is easily read as a 1, and "Counting in
 * each" isn't English. Counters get words instead.
 *
 * Mapping lives on the client on purpose — the API keeps returning the real
 * code, so this is presentation and nothing downstream depends on the wording.
 */
const LABELS: Record<string, string> = {
  kg: 'Counting in Kilograms',
  g: 'Counting in Grams',
  l: 'Counting in Litres',
  ml: 'Counting in Millilitres',
  // No "in" — "Counting in Individual Units" reads as a mouthful, and this is
  // the most common unit on the sheet after kilograms.
  each: 'Counting Individual Units',
  bottle: 'Counting in Bottles',
  pack: 'Counting in Packs',
  case: 'Counting in Cases',
  box: 'Counting in Boxes',
};

/**
 * The line shown under an item name. Returns null when the item has no unit,
 * so the row simply has no second line rather than saying something hollow.
 *
 * An unmapped code falls back to the raw code — visibly odd, which is the
 * point: a new unit should look like it needs a label, not quietly read as a
 * sentence that happens to be wrong.
 */
export function countingLabel(uom: string | null | undefined): string | null {
  if (!uom) return null;
  const key = uom.trim().toLowerCase();
  if (!key) return null;
  return LABELS[key] ?? `Counting in ${uom}`;
}
