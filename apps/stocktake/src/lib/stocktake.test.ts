import { describe, it, expect } from 'vitest';
import { setCount, clearCount } from './storage';
import { groupCatalogue } from './catalogue';
import { countingLabel } from './units';
import { partUnit } from './fractions';
import { dirtyCounted } from './api';
import type { CatalogueItem, CountsMap } from './types';

const base = {
  itemKey: 'k1',
  itemName: 'Caster Sugar',
  section: 'DRY STOCK',
  packSize: '25kg',
  isCustom: false,
};

describe('setCount', () => {
  it('marks an item counted + dirty, even at zero', () => {
    const next = setCount({}, base, 0);
    expect(next.k1!.counted).toBe(true);
    expect(next.k1!.dirty).toBe(true);
    expect(next.k1!.quantity).toBe(0);
  });

  it('overwrites a previous value', () => {
    const next = setCount(setCount({}, base, 3), base, 7);
    expect(next.k1!.quantity).toBe(7);
  });
});

describe('clearCount', () => {
  it('returns an entry to not-counted but keeps it dirty', () => {
    const counted = setCount({}, base, 5);
    const cleared = clearCount(counted, 'k1');
    expect(cleared.k1!.counted).toBe(false);
    expect(cleared.k1!.dirty).toBe(true);
  });
});

describe('dirtyCounted', () => {
  it('returns only counted + dirty entries (not cleared ones)', () => {
    let counts: CountsMap = {};
    counts = setCount(counts, base, 4);
    counts = setCount(counts, { ...base, itemKey: 'k2', itemName: 'Salt' }, 1);
    counts = clearCount(counts, 'k2');
    const out = dirtyCounted(counts);
    expect(out.map((c) => c.itemKey)).toEqual(['k1']);
  });
});

describe('partUnit', () => {
  it('adds a fraction onto the whole number', () => {
    expect(partUnit(0, 0.5)).toBe(0.5);
    expect(partUnit(4, 0.25)).toBe(4.25);
    expect(partUnit(4, 0.75)).toBe(4.75);
  });

  it('keeps the whole number when switching fraction', () => {
    expect(partUnit(4.25, 0.5)).toBe(4.5);
  });

  it('toggles the active fraction back off to the whole number', () => {
    expect(partUnit(0.5, 0.5)).toBe(0);
    expect(partUnit(4.5, 0.5)).toBe(4);
  });
});

describe('groupCatalogue', () => {
  it('groups consecutive items by area + section, preserving order', () => {
    const items: CatalogueItem[] = [
      { key: 'a', area: 'General', section: 'DRY', name: 'Sugar', pack: null, supplier: null, order: 1 },
      { key: 'b', area: 'General', section: 'DRY', name: 'Flour', pack: null, supplier: null, order: 2 },
      { key: 'c', area: 'General', section: 'WET', name: 'Oil', pack: null, supplier: null, order: 3 },
    ];
    const groups = groupCatalogue(items);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.section).toBe('DRY');
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[1]!.section).toBe('WET');
  });
});

describe('countingLabel', () => {
  it('spells the units out for the shelf, not the database', () => {
    expect(countingLabel('kg')).toBe('Counting in Kilograms');
    expect(countingLabel('l')).toBe('Counting in Litres');
    expect(countingLabel('bottle')).toBe('Counting in Bottles');
  });

  it('drops the "in" for individual units', () => {
    expect(countingLabel('each')).toBe('Counting Individual Units');
  });

  it('is case- and whitespace-tolerant', () => {
    expect(countingLabel(' KG ')).toBe('Counting in Kilograms');
  });

  it('gives no line at all when there is no unit', () => {
    expect(countingLabel(null)).toBeNull();
    expect(countingLabel('')).toBeNull();
  });

  it('leaves an unmapped code visibly raw rather than guessing', () => {
    // Looks like it needs a label — better than a confident wrong sentence.
    expect(countingLabel('sachet')).toBe('Counting in sachet');
  });
});
