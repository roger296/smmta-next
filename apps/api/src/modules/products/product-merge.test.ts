/**
 * The merge decision, driven by the real duplicate pairs the live catalogue had.
 *
 * Every fixture below is an actual pair from `find-duplicate-products.ts`
 * against production on 17 Sept 2026.
 */
import { describe, expect, it } from 'vitest';
import { canonicalUom, conversionFactor, decideMerge, type MergeSide } from './product-merge.js';

const side = (p: Partial<MergeSide>): MergeSide => ({
  id: p.stockCode ?? 'id', stockCode: null, stockUom: null,
  recipeLines: 0, supplierCodes: 0, ...p,
});

describe('canonicalUom', () => {
  it.each([['KG', 'kg'], ['Kilograms', 'kg'], ['ltr', 'l'], ['Litres', 'l'], ['ea', 'each'], ['grams', 'g']])(
    'reads %s as %s', (a, b) => expect(canonicalUom(a)).toBe(b),
  );
});

describe('conversionFactor', () => {
  it('converts within mass and within volume', () => {
    expect(conversionFactor('g', 'kg')).toBe(0.001);
    expect(conversionFactor('kg', 'g')).toBe(1000);
    expect(conversionFactor('ml', 'l')).toBe(0.001);
  });

  it('is 1 for the same unit however it is spelled', () => {
    expect(conversionFactor('each', 'each')).toBe(1);
    expect(conversionFactor('KG', 'kilograms')).toBe(1);
  });

  /**
   * The three real pairs this protects: semi-skimmed milk, soya milk and
   * rapeseed oil all exist as litres on one twin and grams on the other.
   * 1 g = 1 ml is water; rapeseed oil is ~0.92 kg/l, so that guess is 8% out on
   * every recipe line forever.
   */
  it.each([['g', 'l'], ['l', 'g'], ['kg', 'ml']])(
    'refuses %s to %s and says it needs a density', (f, t) => {
      const r = conversionFactor(f, t);
      expect(typeof r).toBe('object');
      expect((r as { reason: string }).reason).toMatch(/density/);
    },
  );

  it('refuses each to a weight, which is a pack size not a conversion', () => {
    expect(typeof conversionFactor('each', 'kg')).toBe('object');
  });

  it('refuses a missing unit rather than assuming one', () => {
    expect(typeof conversionFactor('', 'kg')).toBe('object');
  });
});

describe('decideMerge', () => {
  /** Caster Sugar, exactly as production had it. */
  it('keeps the twin holding the supplier codes and converts the recipes onto it', () => {
    const d = decideMerge(
      'Caster Sugar',
      side({ stockCode: 'BAKE-CAST-SUGR', stockUom: 'kg', supplierCodes: 12 }),
      side({ stockCode: 'CASTER-SUGAR', stockUom: 'g', recipeLines: 26 }),
    );
    expect(d.keep.stockCode).toBe('BAKE-CAST-SUGR');
    expect(d.retire.stockCode).toBe('CASTER-SUGAR');
    expect(d.factor).toBe(0.001);
    expect(d.refusal).toBeUndefined();
  });

  it('does not care which way round the pair is handed in', () => {
    const a = side({ stockCode: 'BAKE-CAST-SUGR', stockUom: 'kg', supplierCodes: 12 });
    const b = side({ stockCode: 'CASTER-SUGAR', stockUom: 'g', recipeLines: 26 });
    expect(decideMerge('x', a, b).keep.stockCode).toBe(decideMerge('x', b, a).keep.stockCode);
  });

  /** Whole Eggs: both `each`, so nothing to convert. */
  it('needs no conversion when the units already agree', () => {
    const d = decideMerge(
      'Whole Eggs',
      side({ stockCode: 'DAIR-MEDM-EGGS', stockUom: 'each', supplierCodes: 14 }),
      side({ stockCode: 'WHOLE-EGGS', stockUom: 'each', recipeLines: 23 }),
    );
    expect(d.keep.stockCode).toBe('DAIR-MEDM-EGGS');
    expect(d.factor).toBe(1);
  });

  /** Baking Powder: no supplier codes anywhere, so the unit decides. */
  it('lets the unit decide even when the codes sit on the grams twin', () => {
    const d = decideMerge(
      'Olives',
      side({ stockCode: 'OLIV-G', stockUom: 'g', supplierCodes: 6 }),
      side({ stockCode: 'PITT-MIXD-OLIV', stockUom: 'kg' }),
    );
    expect(d.keep.stockCode).toBe('PITT-MIXD-OLIV');
  });

  it('keeps the non-grams twin when neither side has supplier codes', () => {
    const d = decideMerge(
      'Baking Powder',
      side({ stockCode: 'BAKI-POWD', stockUom: 'kg' }),
      side({ stockCode: 'BAKING-POWDER', stockUom: 'g', recipeLines: 2 }),
    );
    expect(d.keep.stockCode).toBe('BAKI-POWD');
    expect(d.factor).toBe(0.001);
  });

  /** Long Life Semi Skimmed Milk: litres vs grams, with recipes to move. */
  it('refuses the mass-to-volume pairs instead of guessing a density', () => {
    const d = decideMerge(
      'Long Life Semi Skimmed Milk',
      side({ stockCode: 'SEMI-SKIM-MILK', stockUom: 'l', supplierCodes: 8 }),
      side({ stockCode: 'LONG-LIFE-SEMI-SKIMMED-MILK', stockUom: 'g', recipeLines: 1 }),
    );
    expect(d.factor).toBeNull();
    expect(d.refusal).toMatch(/density/);
  });

  /**
   * Olives: same unit, codes on one side, no recipes anywhere. Nothing to
   * convert because nothing moves — a straight retire.
   */
  it('is a plain retire when the doomed twin carries no recipes', () => {
    const d = decideMerge(
      'Olives',
      side({ stockCode: 'PITT-MIXD-OLIV', stockUom: 'kg', supplierCodes: 6 }),
      side({ stockCode: 'OLIV', stockUom: 'kg' }),
    );
    expect(d.keep.stockCode).toBe('PITT-MIXD-OLIV');
    expect(d.retire.stockCode).toBe('OLIV');
    expect(d.factor).toBe(1);
  });

  /**
   * Tater Tots: nothing anywhere, and the units disagree (each vs kg) — which
   * is a product-setup question, not a merge. Handed back.
   */
  it('hands back a pair with nothing to choose between', () => {
    const d = decideMerge(
      'Sausage Rolls',
      side({ stockCode: 'SAUS-ROLL', stockUom: 'kg' }),
      side({ stockCode: 'SAUS-ROLL-2', stockUom: 'each' }),
    );
    // kg vs each: neither is grams, so the unit rule cannot separate them.
    expect(d.refusal).toBeTruthy();
    expect(d.factor).toBeNull();
  });

  it('hands back identical twins rather than tossing a coin', () => {
    const d = decideMerge(
      'Brown',
      side({ stockCode: 'BROW', stockUom: 'kg' }),
      side({ stockCode: 'BROW-2', stockUom: 'kg' }),
    );
    expect(d.refusal).toBeTruthy();
  });
});
