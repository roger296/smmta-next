/**
 * The unit arithmetic behind the Nov-2026 catalogue replacement. The cases are
 * the real shapes in head office's list.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  crossCheck,
  parseSize,
  readCatalogueMapping,
  readNewCatalogue,
  readRemovals,
  scaleQty,
  unitFactor,
} from './catalogue-replace.js';

const factorOf = (o: string, n: string, size: string) => {
  const f = unitFactor(o, n, size);
  if (!('factor' in f)) throw new Error(f.refusal);
  return f.factor;
};

describe('parseSize', () => {
  it.each([
    ['250g', 250, 'g'],
    ['1.65kg', 1650, 'g'],
    ['70cl', 700, 'ml'],
    ['500ml', 500, 'ml'],
    ['3l bag', 3000, 'ml'],
    ['25kg', 25000, 'g'],
  ])('%s', (size, qty, base) => {
    expect(parseSize(size)).toEqual({ qty, base });
  });

  it.each(['1 lemon', '40 arancini box', '14 slices', 'Made in-house', '', '1 x 750ml'])(
    'is not a weight or volume: %s',
    (size) => {
      expect(parseSize(size)).toBeNull();
    },
  );
});

describe('unitFactor - how many new units one old unit is', () => {
  it('kilograms to 25 kg sacks', () => {
    expect(factorOf('kg', 'each', '25kg')).toBeCloseTo(0.04, 10);
  });

  it('kilograms to 250 g blocks', () => {
    expect(factorOf('kg', 'each', '250g')).toBe(4);
  });

  it('grams to a 500 g pack', () => {
    expect(factorOf('g', 'each', '500g')).toBeCloseTo(0.002, 10);
  });

  it('litres to 70 cl bottles', () => {
    expect(factorOf('l', 'each', '70cl')).toBeCloseTo(1000 / 700, 10);
  });

  it('kilograms to grams', () => {
    expect(factorOf('kg', 'g', 'Made in-house')).toBe(1000);
  });

  it('a bottle, a bag or a can is one of a thing', () => {
    expect(factorOf('bottle', 'each', '70cl')).toBe(1);
    expect(factorOf('bag', 'each', '100g')).toBe(1);
    expect(factorOf('can', 'each', '330ml')).toBe(1);
  });

  it('refuses grams against a volume (a density, which differs per product)', () => {
    expect(unitFactor('g', 'each', '1l')).toMatchObject({ refusal: expect.stringMatching(/density/) });
    expect(unitFactor('l', 'each', '1kg')).toMatchObject({ refusal: expect.stringMatching(/density/) });
  });

  it('refuses a weight against "1 lemon"', () => {
    expect(unitFactor('kg', 'each', '1 lemon')).toMatchObject({ refusal: expect.stringMatching(/not a weight/) });
  });

  it('refuses a bottle becoming litres - the bottle size was never recorded', () => {
    expect(unitFactor('bottle', 'l', 'Made in-house')).toMatchObject({ refusal: expect.stringMatching(/not recorded/) });
  });
});

describe('scaleQty', () => {
  it('converts exactly at 4 decimal places', () => {
    expect(scaleQty('0.1000', 0.04, 4)).toEqual({ value: '0.0040', ok: true });
  });

  it('refuses a quantity that would round to zero', () => {
    // 1 g of something bought in 25 kg sacks: 0.00004 sacks.
    expect(scaleQty('1', 0.00004, 4)).toMatchObject({ value: '0.0000', ok: false });
  });

  it('refuses a quantity rounding would move by more than half a percent', () => {
    expect(scaleQty('0.0125', 1 / 3.5, 4).ok).toBe(false);
  });

  it('passes a null through', () => {
    expect(scaleQty(null, 4, 4)).toEqual({ value: null, ok: true });
  });
});

describe('the committed files', () => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'data', 'catalogue-2026-11');
  const list = readNewCatalogue(readFileSync(join(dir, 'new-list.csv'), 'utf8'));
  const mapping = readCatalogueMapping(readFileSync(join(dir, 'mapping.csv'), 'utf8'));
  const removals = readRemovals(readFileSync(join(dir, 'removals.csv'), 'utf8'));

  it('agree with each other', () => {
    expect(list).toHaveLength(438);
    expect(removals).toHaveLength(167);
    expect(crossCheck(list, mapping, removals)).toEqual([]);
  });

  it('use the 18 sub-categories the owners chose', () => {
    expect(new Set(list.map((r) => r.subCategory)).size).toBe(18);
  });
});

describe('crossCheck', () => {
  const row = (code: string) => ({
    stockCode: code, name: code, itemCategory: 'Bar', subCategory: 'Wine', stockUom: 'each', size: '75cl',
    purchaseUom: '', stockCheckInstruction: '', comments: '',
  });

  it('names a line with no mapping row and an old code claimed twice', () => {
    expect(
      crossCheck([row('A'), row('B'), row('C')], [
        { newStockCode: 'A', oldStockCodes: ['OLD'], check: '' },
        { newStockCode: 'B', oldStockCodes: ['OLD'], check: '' },
      ]),
    ).toEqual(['old code OLD is mapped to both A and B', 'C has no mapping row']);
  });

  it('names an old code that is both removed and kept', () => {
    expect(
      crossCheck([row('A')], [{ newStockCode: 'A', oldStockCodes: ['OLD'], check: '' }], [
        { stockCode: 'OLD', name: '', reason: 'Remove.' },
      ]),
    ).toEqual(['old code OLD is both removed and mapped to A']);
  });
});
