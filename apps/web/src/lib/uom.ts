/**
 * Front-end UoM helpers for the iPad jobs (P13, spec §A3). Mirrors the
 * server-side conversion so goods-in shows a live purchase→stock figure and
 * stock-take counts can be bucketed to a quantum for fungibles.
 */
export function purchaseToStock(purchaseQty: number, factor: number): number {
  return purchaseQty * factor;
}

const DISCRETE = new Set(['each', 'ea', 'unit', 'units', 'item', 'items', 'pcs', 'piece']);

export function isDiscreteUom(uom: string): boolean {
  return DISCRETE.has(uom.trim().toLowerCase());
}

/**
 * Round a count to a configured quantum — **opt-in only** (Aug-2026 feedback,
 * defect D-2).
 *
 * This used to be `bucketCount(qty, uom, quantum = 100)`: every non-discrete
 * count was silently rounded to the nearest 100 *stock units*. Across mixed
 * units that is destructive rather than tidy — a 4 kg count of icing sugar
 * submitted as **0**, a 250 g count as 300 — and on approval the ledger is
 * trued up to the destroyed figure. It was masked in production by defect D-1
 * (with no product map the UoM fell back to `each`, which is discrete and
 * never bucketed), so fixing D-1 without this would have started destroying
 * real counts.
 *
 * There is deliberately **no default**. A quantum is only ever meaningful when
 * it is configured per product, in that product's own stock unit — a 100 g
 * scoop is sensible for flour, meaningless for `each`, and catastrophic for
 * `kg`. Omitting the argument, or passing null/undefined/≤0, returns the
 * quantity **unchanged**, so no call site can inherit bucketing by accident.
 *
 * The per-product setting lives in `products.count_quantum` (nullable; NULL =
 * no bucketing) and reaches the count screen on the stock-take line.
 */
export function bucketCount(qty: number, uom: string, quantum?: number | null): number {
  if (quantum == null || quantum <= 0) return qty;
  if (isDiscreteUom(uom)) return qty;
  return Math.round(qty / quantum) * quantum;
}

// ── Full unit names ─────────────────────────────────────────────────────────
//
// The venue screens spell units out (Sept-2026 request): "Count this item in
// kilograms", "Expected 500 grams", "£0.0012 per gram". A baker holding an
// iPad should not have to decode "g" against "kg" against "l" at a shelf, and
// the abbreviations are where a 4 kg count gets entered as 4000.
//
// BOTH forms are stored because English needs both: "in grams" (plural label)
// but "per gram" (singular after "per"), and "1 gram" vs "500 grams" depends
// on the number in front of it. A single form gets one of those wrong
// everywhere it is used.
//
// A lookup rather than a pluralisation algorithm: the units are a small closed
// set head office controls, and a rule that produces "litres"/"litre" also
// produces "boxs" and "kgs". Anything unmapped falls through as stored, which
// is no worse than the bare token it replaced.
const UOM_NAMES: Record<string, { one: string; many: string }> = {
  g: { one: 'gram', many: 'grams' },
  kg: { one: 'kilogram', many: 'kilograms' },
  mg: { one: 'milligram', many: 'milligrams' },
  l: { one: 'litre', many: 'litres' },
  ltr: { one: 'litre', many: 'litres' },
  litre: { one: 'litre', many: 'litres' },
  ml: { one: 'millilitre', many: 'millilitres' },
  cl: { one: 'centilitre', many: 'centilitres' },
  oz: { one: 'ounce', many: 'ounces' },
  lb: { one: 'pound', many: 'pounds' },
  floz: { one: 'fluid ounce', many: 'fluid ounces' },
  pt: { one: 'pint', many: 'pints' },
  gal: { one: 'gallon', many: 'gallons' },
  each: { one: 'single unit', many: 'single units' },
  ea: { one: 'single unit', many: 'single units' },
  unit: { one: 'single unit', many: 'single units' },
  units: { one: 'single unit', many: 'single units' },
  item: { one: 'single unit', many: 'single units' },
  items: { one: 'single unit', many: 'single units' },
  pcs: { one: 'single unit', many: 'single units' },
  piece: { one: 'single unit', many: 'single units' },
  pack: { one: 'pack', many: 'packs' },
  packs: { one: 'pack', many: 'packs' },
  box: { one: 'box', many: 'boxes' },
  boxes: { one: 'box', many: 'boxes' },
  case: { one: 'case', many: 'cases' },
  cases: { one: 'case', many: 'cases' },
  bottle: { one: 'bottle', many: 'bottles' },
  bottles: { one: 'bottle', many: 'bottles' },
  can: { one: 'can', many: 'cans' },
  cans: { one: 'can', many: 'cans' },
  tub: { one: 'tub', many: 'tubs' },
  tubs: { one: 'tub', many: 'tubs' },
  tray: { one: 'tray', many: 'trays' },
  trays: { one: 'tray', many: 'trays' },
  bag: { one: 'bag', many: 'bags' },
  bags: { one: 'bag', many: 'bags' },
  sack: { one: 'sack', many: 'sacks' },
  sacks: { one: 'sack', many: 'sacks' },
  jar: { one: 'jar', many: 'jars' },
  jars: { one: 'jar', many: 'jars' },
  tin: { one: 'tin', many: 'tins' },
  tins: { one: 'tin', many: 'tins' },
  roll: { one: 'roll', many: 'rolls' },
  rolls: { one: 'roll', many: 'rolls' },
  sheet: { one: 'sheet', many: 'sheets' },
  sheets: { one: 'sheet', many: 'sheets' },
  bunch: { one: 'bunch', many: 'bunches' },
  bunches: { one: 'bunch', many: 'bunches' },
  punnet: { one: 'punnet', many: 'punnets' },
  punnets: { one: 'punnet', many: 'punnets' },
  keg: { one: 'keg', many: 'kegs' },
  kegs: { one: 'keg', many: 'kegs' },
};

/** "kg" -> "kilograms". Unknown units come back as stored; empty -> null. */
export function uomFullName(uom: string | null | undefined): string | null {
  const key = (uom ?? '').trim().toLowerCase();
  if (!key) return null;
  return UOM_NAMES[key]?.many ?? uom!.trim();
}

/** "kg" -> "kilogram". For "per <unit>", where the plural would be wrong. */
export function uomFullNameSingular(uom: string | null | undefined): string | null {
  const key = (uom ?? '').trim().toLowerCase();
  if (!key) return null;
  return UOM_NAMES[key]?.one ?? uom!.trim();
}

/**
 * "500 grams", "1 gram", "0 grams".
 *
 * Zero takes the plural, as English does. A missing unit yields just the
 * number rather than a trailing space.
 */
export function formatQtyUom(qty: number, uom: string | null | undefined): string {
  const name = Math.abs(qty) === 1 ? uomFullNameSingular(uom) : uomFullName(uom);
  return name ? `${qty} ${name}` : String(qty);
}

/** Human wording for a bucketed row, so a counter can see what happened to
 *  their number rather than discovering it on the variance report. */
export function bucketNote(quantum: number | null | undefined, uom: string): string | null {
  if (quantum == null || quantum <= 0 || isDiscreteUom(uom)) return null;
  return `rounded to nearest ${formatQtyUom(quantum, uom)}`;
}
