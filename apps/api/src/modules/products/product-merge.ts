/**
 * Merging a duplicated product into the twin that survives.
 *
 * The live catalogue carried 29 names used by two products each. The diagnostic
 * showed the two "uses" barely overlap — across all 16 contested pairs the
 * count-list twin holds the SUPPLIER CODES and no recipes, while the recipe-
 * import twin holds the RECIPE LINES and no supplier codes:
 *
 *     Caster Sugar  BAKE-CAST-SUGR  kg  recipes=0   supplierCodes=12
 *     Caster Sugar  CASTER-SUGAR    g   recipes=26  supplierCodes=0
 *
 * So a merge is mostly a repoint. The one genuinely dangerous part is the unit:
 * recipes and reorder points are denominated in the product's OWN `stock_uom`
 * (see modules/stock/uom.ts), and there is no g/kg converter anywhere in the
 * system. Move a line reading `qty_per_cover: 250` from a grams product onto a
 * kilograms one without dividing and every bake consumes a thousand times too
 * much, the variance reads as theft, and reorder tries to buy a tonne of sugar.
 */

/** Units this can convert between, and what one of `from` is worth in `to`. */
const FACTORS: Record<string, Record<string, number>> = {
  g: { g: 1, kg: 0.001 },
  kg: { kg: 1, g: 1000 },
  ml: { ml: 1, l: 0.001 },
  l: { l: 1, ml: 1000 },
  each: { each: 1 },
};

/** Spellings that mean the same unit. */
const UOM_ALIASES: Record<string, string> = {
  g: 'g', gram: 'g', grams: 'g', gm: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', ltr: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  each: 'each', ea: 'each', unit: 'each', units: 'each', item: 'each', pcs: 'each',
};

export function canonicalUom(uom: string | null | undefined): string {
  const k = (uom ?? '').trim().toLowerCase();
  return UOM_ALIASES[k] ?? k;
}

export interface ConversionRefusal {
  reason: string;
}

/**
 * What to multiply a quantity by when moving it from one product's stock unit
 * to another's, or a refusal.
 *
 * ⚠️ Mass and volume do NOT convert. `Long Life Semi Skimmed Milk` exists as
 * both litres and grams, and so do the soya milk and the rapeseed oil — and
 * grams to litres needs a DENSITY, which differs per liquid (rapeseed oil is
 * about 0.92 kg/l, milk about 1.03). Guessing 1 g = 1 ml is water's density and
 * is wrong by 8% for the oil. Being 8% out on every recipe line forever is not
 * worth saving an operator one decision, so those are refused by name and
 * handed back.
 */
export function conversionFactor(from: string, to: string): number | ConversionRefusal {
  const f = canonicalUom(from);
  const t = canonicalUom(to);
  if (!f || !t) return { reason: `missing stock unit (${from || '-'} -> ${to || '-'})` };
  if (f === t) return 1;
  const factor = FACTORS[f]?.[t];
  if (factor != null) return factor;
  const mass = new Set(['g', 'kg']);
  const volume = new Set(['ml', 'l']);
  if ((mass.has(f) && volume.has(t)) || (volume.has(f) && mass.has(t))) {
    return {
      reason:
        `${f} to ${t} needs a density, which differs per liquid ` +
        '(rapeseed oil ~0.92 kg/l, milk ~1.03) - set the two products to the same unit by hand first',
    };
  }
  return { reason: `no conversion between ${f} and ${t}` };
}

export interface MergeSide {
  id: string;
  stockCode: string | null;
  stockUom: string | null;
  recipeLines: number;
  supplierCodes: number;
}

export interface MergeDecision {
  name: string;
  keep: MergeSide;
  retire: MergeSide;
  /** Multiply the retired side's recipe quantities by this. */
  factor: number | null;
  /** Set when this pair cannot be merged automatically. */
  refusal?: string;
}

/**
 * Which twin survives.
 *
 * THE UNIT DECIDES FIRST. Whichever twin is NOT in grams, because that is the
 * count-list product and the unit the venue actually counts in — the stock-take
 * row literally reads "count this item in Kilograms", and a grams product would
 * have somebody counting a sack of flour in grams. Supplier codes can be moved;
 * the unit is the product's identity.
 *
 * Supplier codes break the tie when the unit cannot — `Olives` exists twice in
 * kilograms, and the twin the invoice import already attached six Brakes codes
 * to is the real one. On the live data both rules agree everywhere, which is
 * the reassuring case; the ordering only matters for pairs neither of us has
 * seen yet.
 *
 * With nothing to separate them it is a coin toss, and the pair is handed back
 * rather than decided.
 */
export function decideMerge(name: string, a: MergeSide, b: MergeSide): MergeDecision {
  let keep: MergeSide | null = null;
  let retire: MergeSide | null = null;

  const aG = canonicalUom(a.stockUom) === 'g';
  const bG = canonicalUom(b.stockUom) === 'g';
  if (aG !== bG) [keep, retire] = aG ? [b, a] : [a, b];
  else if (a.supplierCodes > 0 && b.supplierCodes === 0) [keep, retire] = [a, b];
  else if (b.supplierCodes > 0 && a.supplierCodes === 0) [keep, retire] = [b, a];

  if (!keep || !retire) {
    return {
      name,
      keep: a,
      retire: b,
      factor: null,
      refusal:
        'nothing distinguishes the two - same unit, and supplier codes on both sides or neither. Pick one by hand.',
    };
  }

  // Only the recipe lines actually move, so a conversion is only needed when
  // there are any to move.
  if (retire.recipeLines === 0) return { name, keep, retire, factor: 1 };

  const f = conversionFactor(retire.stockUom ?? '', keep.stockUom ?? '');
  if (typeof f !== 'number') return { name, keep, retire, factor: null, refusal: f.reason };
  return { name, keep, retire, factor: f };
}
