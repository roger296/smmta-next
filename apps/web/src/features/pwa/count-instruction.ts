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
 * Full names for the stock units this catalogue uses.
 *
 * Deliberately a lookup with a fallback rather than a clever pluraliser: the
 * units are a closed, small set that head office controls, and "Count this item
 * in kgs" reads as though nobody checked. An unmapped unit falls back to the
 * unit itself, which is no worse than the line it replaced.
 */
const UOM_FULL_NAMES: Record<string, string> = {
  g: 'grams',
  kg: 'kilograms',
  mg: 'milligrams',
  l: 'litres',
  ltr: 'litres',
  litre: 'litres',
  ml: 'millilitres',
  cl: 'centilitres',
  oz: 'ounces',
  lb: 'pounds',
  floz: 'fluid ounces',
  pt: 'pints',
  gal: 'gallons',
  each: 'single units',
  ea: 'single units',
  unit: 'single units',
  units: 'single units',
  item: 'single units',
  items: 'single units',
  pcs: 'single units',
  piece: 'single units',
  pack: 'packs',
  packs: 'packs',
  box: 'boxes',
  boxes: 'boxes',
  case: 'cases',
  cases: 'cases',
  bottle: 'bottles',
  bottles: 'bottles',
  can: 'cans',
  cans: 'cans',
  tub: 'tubs',
  tubs: 'tubs',
  tray: 'trays',
  trays: 'trays',
  bag: 'bags',
  bags: 'bags',
  sack: 'sacks',
  sacks: 'sacks',
  jar: 'jars',
  jars: 'jars',
  tin: 'tins',
  tins: 'tins',
  roll: 'rolls',
  rolls: 'rolls',
  sheet: 'sheets',
  sheets: 'sheets',
  bunch: 'bunches',
  bunches: 'bunches',
  punnet: 'punnets',
  punnets: 'punnets',
  keg: 'kegs',
  kegs: 'kegs',
};

/** "kg" -> "kilograms". An unknown unit is returned as it was stored. */
export function uomFullName(uom: string | null | undefined): string | null {
  const key = (uom ?? '').trim().toLowerCase();
  if (!key) return null;
  return UOM_FULL_NAMES[key] ?? uom!.trim();
}

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
