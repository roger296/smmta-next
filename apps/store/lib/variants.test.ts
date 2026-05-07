import { describe, expect, it } from 'vitest';
import { pickDefaultVariant, resolveInitialVariant } from './variants';

const v = (id: string, colour: string | null, availableQty: number) => ({
  id,
  colour,
  availableQty,
});

describe('pickDefaultVariant', () => {
  it('returns undefined for an empty list', () => {
    expect(pickDefaultVariant([])).toBeUndefined();
  });

  it('returns the only variant when there is one (in stock)', () => {
    const a = v('a', 'Smoke', 5);
    expect(pickDefaultVariant([a])).toBe(a);
  });

  it('returns the only variant when there is one (out of stock)', () => {
    const a = v('a', 'Smoke', 0);
    expect(pickDefaultVariant([a])).toBe(a);
  });

  it('returns the first variant when all are in stock', () => {
    const a = v('a', 'Amber', 3);
    const b = v('b', 'Smoke', 2);
    expect(pickDefaultVariant([a, b])).toBe(a);
  });

  it('returns the first IN-STOCK variant when the first is out of stock', () => {
    const a = v('a', 'Amber', 0);
    const b = v('b', 'Smoke', 4);
    const c = v('c', 'Sand', 1);
    expect(pickDefaultVariant([a, b, c])).toBe(b);
  });

  it('falls back to the first variant when every variant is out of stock', () => {
    const a = v('a', 'Amber', 0);
    const b = v('b', 'Smoke', 0);
    expect(pickDefaultVariant([a, b])).toBe(a);
  });
});

describe('resolveInitialVariant', () => {
  const a = v('a', 'Amber', 0);
  const b = v('b', 'Smoke', 4);
  const c = v('c', 'Sand', 1);
  const list = [a, b, c];

  it('honours an explicit ?colour= even when out of stock', () => {
    expect(resolveInitialVariant(list, 'Amber')).toBe(a);
    expect(resolveInitialVariant(list, 'amber')).toBe(a); // case-insensitive
  });

  it('falls through to the in-stock default when ?colour= does not match', () => {
    expect(resolveInitialVariant(list, 'NoSuchColour')).toBe(b);
  });

  it('falls through to the in-stock default when ?colour= is null/empty', () => {
    expect(resolveInitialVariant(list, null)).toBe(b);
    expect(resolveInitialVariant(list, undefined)).toBe(b);
    expect(resolveInitialVariant(list, '')).toBe(b);
  });

  it('returns undefined for an empty list regardless of query', () => {
    expect(resolveInitialVariant([], 'Smoke')).toBeUndefined();
    expect(resolveInitialVariant([], null)).toBeUndefined();
  });
});
