import { describe, expect, it } from 'vitest';
import { describeLastPrice, splitAliases } from './supplier-mappings-tab';

describe('splitAliases', () => {
  it('splits on commas', () => {
    expect(splitAliases('A 33891, A33891')).toEqual(['A 33891', 'A33891']);
  });

  // A supplier code legitimately contains a space — "A 33891" is one code, not
  // two — so splitting on whitespace would break the very case this exists for.
  it('keeps a space INSIDE a code', () => {
    expect(splitAliases('A 33891')).toEqual(['A 33891']);
  });

  it('trims each one', () => {
    expect(splitAliases('  A33891 ,   A 33891  ')).toEqual(['A33891', 'A 33891']);
  });

  it('drops empties from trailing or doubled commas', () => {
    expect(splitAliases('A33891,,')).toEqual(['A33891']);
    expect(splitAliases(', A33891 ,')).toEqual(['A33891']);
  });

  it('returns nothing for an empty box', () => {
    expect(splitAliases('')).toEqual([]);
    expect(splitAliases('   ')).toEqual([]);
  });
});

describe('describeLastPrice', () => {
  const base = {
    unitPrice: '21.100000',
    currencyCode: 'GBP',
    source: 'INVOICE' as const,
    observedAt: '2026-09-20T12:00:00.000Z',
    documentRef: 'INV-9',
    ageDays: 9,
    stale: false,
  };

  it('says what was paid and where the figure came from', () => {
    expect(describeLastPrice(base)).toEqual({ price: '£21.10', detail: 'invoice, 20 Sept 2026' });
  });

  it('says how old a stale price is', () => {
    expect(describeLastPrice({ ...base, observedAt: '2026-05-01T12:00:00.000Z', ageDays: 151, stale: true }).detail).toBe(
      'invoice, 1 May 2026 — 151 days old',
    );
  });

  it('shows a Dallas price in dollars', () => {
    expect(describeLastPrice({ ...base, currencyCode: 'USD', source: 'PO_CONFIRMED' })).toEqual({
      price: '$21.10',
      detail: 'order confirmation, 20 Sept 2026',
    });
  });
});

