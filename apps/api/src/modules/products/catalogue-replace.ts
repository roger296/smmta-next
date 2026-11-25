/**
 * Replacing the product catalogue with a new list — the pure half.
 *
 * In Nov 2026 head office re-coded and re-named the whole catalogue (438
 * lines, every one with a new stock code, a new name, an item category and a
 * "count it like this" instruction). The new list says nothing about which
 * existing product each line replaces, so a hand-checked mapping file does
 * (`data/catalogue-2026-11/mapping.csv`), and `scripts/replace-catalogue.ts`
 * applies the two. This module is the part with no database in it: reading
 * the files, and the unit arithmetic, which is where the danger is.
 *
 * ⚠️ WHY THE UNITS MATTER. Recipes, reorder points and the stock position are
 * all denominated in the product's OWN `stock_uom`. The new list changes that
 * unit for most products — "Sugar - Caster" goes from kilograms to `each`, one
 * each being a 25 kg sack, because the venue now counts sacks to the nearest
 * quarter. A recipe line reading 0.1 left as it is would mean 0.1 SACKS, a
 * fortieth of what it said. So every quantity is multiplied by the factor
 * between the two units, and a product whose factor cannot be known (litres to
 * grams needs a density; "1 lemon" is not a weight) keeps its old unit and is
 * reported, rather than guessed.
 */
import { parse as csvParse } from 'csv-parse/sync';
import { canonicalUom, conversionFactor } from './product-merge.js';

export interface NewCatalogueRow {
  stockCode: string;
  name: string;
  /** The top level (Bar, Baking …) — informational; see `subCategory`. */
  itemCategory: string;
  /** What becomes the product's item category (owners' choice, Nov 2026). */
  subCategory: string;
  stockUom: string;
  /** "250g", "70cl", "3l bag", "1 lemon" — how big one stock unit is. */
  size: string;
  /** "24 x 330ml", "Custom order" — how it is bought. */
  purchaseUom: string;
  stockCheckInstruction: string;
  comments: string;
}

export interface CatalogueMappingRow {
  newStockCode: string;
  /** First is the product kept and re-coded; the rest are merged into it. */
  oldStockCodes: string[];
  /** Why a pairing is a judgement call, for the person reviewing it. */
  check: string;
}

function records(text: string): Array<Record<string, string>> {
  return csvParse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Array<
    Record<string, string>
  >;
}

export function readNewCatalogue(text: string): NewCatalogueRow[] {
  return records(text).map((r) => ({
    stockCode: r.stock_code ?? '',
    name: r.name ?? '',
    itemCategory: r.item_category ?? '',
    subCategory: r.sub_category ?? '',
    stockUom: r.stock_uom ?? '',
    size: r.size ?? '',
    purchaseUom: r.purchase_uom ?? '',
    stockCheckInstruction: r.stock_check_instruction ?? '',
    comments: r.comments ?? '',
  }));
}

export function readCatalogueMapping(text: string): CatalogueMappingRow[] {
  return records(text).map((r) => ({
    newStockCode: r.new_stock_code ?? '',
    oldStockCodes: (r.old_stock_codes ?? '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean),
    check: r.check ?? '',
  }));
}

export interface CatalogueRemovalRow {
  stockCode: string;
  name: string;
  reason: string;
}

export function readRemovals(text: string): CatalogueRemovalRow[] {
  return records(text).map((r) => ({
    stockCode: r.old_stock_code ?? '',
    name: r.name ?? '',
    reason: r.reason ?? '',
  }));
}

/**
 * Densities somebody has decided, per OLD stock code. Without one, grams and
 * litres never convert (see `conversionFactor`); with one, they do, and the
 * file records who decided and why.
 */
export function readDensities(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records(text)) {
    const g = Number(r.grams_per_ml);
    if (r.old_stock_code && g > 0) out.set(r.old_stock_code.toUpperCase(), g);
  }
  return out;
}

/**
 * Units that mean "one of a thing". A bottle, a bag and an `each` are all one
 * item, so moving between them changes the word, not the number — the
 * precedent the product import set ("each" -> "can" keeps its cost).
 */
const COUNT_UNITS = new Set([
  'each', 'bottle', 'can', 'bag', 'tub', 'box', 'roll', 'jar', 'pad', 'cake', 'pack', 'packet',
  'carton', 'tin', 'pouch', 'tube', 'case', 'sack',
]);
const MASS = new Set(['g', 'kg']);
const VOLUME = new Set(['ml', 'l']);

export function isCountUnit(uom: string): boolean {
  return COUNT_UNITS.has(canonicalUom(uom));
}

/**
 * How big one stock unit is, from the list's Size column, in grams or
 * millilitres. Only a leading quantity-and-unit counts: "3l bag" is 3000 ml,
 * "1.65kg" is 1650 g. "1 lemon", "40 arancini box", "14 slices" and "Made
 * in-house" are not weights or volumes, and return null rather than a guess.
 */
export function parseSize(size: string): { qty: number; base: 'g' | 'ml' } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l)\b/i.exec(size ?? '');
  if (!m) return null;
  const qty = Number(m[1]);
  if (!(qty > 0)) return null;
  switch (m[2]!.toLowerCase()) {
    case 'kg': return { qty: qty * 1000, base: 'g' };
    case 'g': return { qty, base: 'g' };
    case 'l': return { qty: qty * 1000, base: 'ml' };
    case 'cl': return { qty: qty * 10, base: 'ml' };
    default: return { qty, base: 'ml' };
  }
}

export type UnitFactor = { factor: number; how: string } | { refusal: string };

/**
 * How many NEW stock units one OLD stock unit is.
 *
 *   kg  -> kg                 1
 *   bottle -> each            1 (both "one of a thing")
 *   kg  -> each, size 250g    4 (a kilogram is four 250 g blocks)
 *   g   -> each, size 25kg    0.00004
 *   l   -> each, size 70cl    1.428…
 *
 * and refusals, by name, for the ones nobody can know: grams against litres
 * (a density, which differs per liquid — see `conversionFactor`), a weight
 * against "1 lemon", and a bottle against litres (how big was the bottle?).
 */
export function unitFactor(oldUom: string, newUom: string, size: string, gramsPerMl?: number): UnitFactor {
  const from = canonicalUom(oldUom);
  const to = canonicalUom(newUom);
  if (!from || !to) return { refusal: `missing stock unit (${oldUom || '-'} -> ${newUom || '-'})` };
  if (from === to) return { factor: 1, how: 'same unit' };
  if (isCountUnit(from) && isCountUnit(to)) return { factor: 1, how: `${from} -> ${to}, one for one` };

  const measured = (u: string) => MASS.has(u) || VOLUME.has(u);
  /** Grams or millilitres in one of `u`. */
  const base = (u: string) => (u === 'kg' || u === 'l' ? 1000 : 1);
  if (measured(from) && measured(to)) {
    const f = conversionFactor(from, to);
    if (typeof f === 'number') return { factor: f, how: `${from} -> ${to}` };
    if (!gramsPerMl) return { refusal: f.reason };
    // Mass <-> volume with a density somebody has named for this product.
    const factor = MASS.has(from)
      ? base(from) / gramsPerMl / base(to)
      : (base(from) * gramsPerMl) / base(to);
    return { factor, how: `${from} -> ${to} at ${gramsPerMl} g/ml` };
  }

  if (measured(from) && isCountUnit(to)) {
    const s = parseSize(size);
    if (!s) {
      return {
        refusal:
          `${from} -> ${to}: the list's size "${size || '(blank)'}" is not a weight or volume, ` +
          'so how many of the old unit make one new one is not known',
      };
    }
    const fromBase = MASS.has(from) ? 'g' : 'ml';
    if (fromBase !== s.base && gramsPerMl) {
      // e.g. grams of aquafaba into 1 l bottles, at a named density.
      const inSizeBase = fromBase === 'g' ? base(from) / gramsPerMl : base(from) * gramsPerMl;
      return { factor: inSizeBase / s.qty, how: `${from} -> ${to} of ${size} at ${gramsPerMl} g/ml` };
    }
    if (fromBase !== s.base) {
      return {
        refusal:
          `${from} -> ${to} of ${size}: ${fromBase === 'g' ? 'grams' : 'litres'} against ` +
          `${s.base === 'g' ? 'grams' : 'litres'} needs a density, which differs per product`,
      };
    }
    const perOld = from === 'kg' || from === 'l' ? 1000 : 1;
    return { factor: perOld / s.qty, how: `${from} -> ${to} of ${size}` };
  }

  // A count unit becoming a weight or volume: the old container's size is not
  // recorded anywhere, so "3 bottles" cannot become litres.
  return { refusal: `${from} -> ${to}: how much one old ${from} held is not recorded` };
}

/**
 * A quantity multiplied by `factor` and rounded to the column's scale, or a
 * refusal when the rounding would change it materially.
 *
 * Recipe quantities are `numeric(18,4)`. 1 g of salt per cover in a 25 kg-sack
 * product is 0.00004 sacks, which rounds to ZERO — the ingredient would vanish
 * from the recipe and nothing would say so. Anything that loses more than half
 * a percent is refused.
 */
export function scaleQty(
  value: string | number | null,
  factor: number,
  scale: number,
): { value: string | null; ok: boolean } {
  if (value == null) return { value: null, ok: true };
  const exact = Number(value) * factor;
  const rounded = Number(exact.toFixed(scale));
  if (exact === 0) return { value: rounded.toFixed(scale), ok: true };
  const ok = rounded !== 0 && Math.abs(rounded - exact) / Math.abs(exact) <= 0.005;
  return { value: rounded.toFixed(scale), ok };
}

/** How the item is bought, as the delivery note says it. */
export function packDescriptionFor(row: NewCatalogueRow): string | null {
  const text = (row.purchaseUom || row.size || '').trim();
  return text ? text.slice(0, 120) : null;
}

/**
 * The item kind for a line the old catalogue never had. Existing products keep
 * theirs — somebody may have set it deliberately.
 */
export function newProductKind(row: NewCatalogueRow): { itemKind: 'MERCH' | 'RETAIL' | 'INGREDIENT'; isSold: boolean } {
  if (row.itemCategory === 'Merchandise') return { itemKind: 'MERCH', isSold: true };
  if (row.itemCategory === 'Bar') return { itemKind: 'RETAIL', isSold: true };
  if (row.subCategory === 'Cakes & Pastries' || row.subCategory === 'Snacks & Sweets') {
    return { itemKind: 'RETAIL', isSold: true };
  }
  if (row.itemCategory === 'Baking' || row.itemCategory === 'Food') return { itemKind: 'INGREDIENT', isSold: false };
  return { itemKind: 'RETAIL', isSold: false };
}

/**
 * Everything wrong with the two files together, before any database is
 * touched: a list line with no mapping row (or two), an old code claimed by
 * two lines, or one both removed and kept. An empty array means they agree.
 */
export function crossCheck(
  list: NewCatalogueRow[],
  mapping: CatalogueMappingRow[],
  removals: CatalogueRemovalRow[] = [],
): string[] {
  const problems: string[] = [];
  const listCodes = new Map<string, number>();
  for (const r of list) {
    if (!r.stockCode || !r.name || !r.stockUom || !r.subCategory) {
      problems.push(`list line "${r.stockCode || r.name}" is missing a stock code, name, unit or sub-category`);
    }
    listCodes.set(r.stockCode.toUpperCase(), (listCodes.get(r.stockCode.toUpperCase()) ?? 0) + 1);
    if (r.stockCheckInstruction.length > 200) problems.push(`${r.stockCode}: instruction over 200 characters`);
  }
  for (const [code, n] of listCodes) if (n > 1) problems.push(`${code} appears ${n} times in the list`);

  const mapped = new Map<string, number>();
  const claimed = new Map<string, string>();
  for (const m of mapping) {
    const k = m.newStockCode.toUpperCase();
    mapped.set(k, (mapped.get(k) ?? 0) + 1);
    if (!listCodes.has(k)) problems.push(`mapping row ${m.newStockCode} is not in the list`);
    for (const o of m.oldStockCodes) {
      const ok = o.toUpperCase();
      const prior = claimed.get(ok);
      if (prior) problems.push(`old code ${o} is mapped to both ${prior} and ${m.newStockCode}`);
      else claimed.set(ok, m.newStockCode);
    }
  }
  for (const r of removals) {
    const prior = claimed.get(r.stockCode.toUpperCase());
    if (prior) problems.push(`old code ${r.stockCode} is both removed and mapped to ${prior}`);
  }
  for (const code of listCodes.keys()) {
    const n = mapped.get(code) ?? 0;
    if (n === 0) problems.push(`${code} has no mapping row`);
    if (n > 1) problems.push(`${code} has ${n} mapping rows`);
  }
  return problems;
}
