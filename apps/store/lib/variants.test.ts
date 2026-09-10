import { describe, expect, it } from 'vitest';
import { pickDefaultVariant, resolveInitialVariant, variantCeilingGbp, variantFloorGbp, colourLinks } from './variants';
import type { StockState } from './api-types';

const v = (
  id: string,
  colour: string | null,
  availableQty: number,
  stockState?: StockState,
) => ({ id, colour, availableQty, stockState });

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

  it('prefers IN_STOCK over AVAILABLE_FROM_SUPPLIER', () => {
    const a = v('a', 'Amber', 0, 'AVAILABLE_FROM_SUPPLIER');
    const b = v('b', 'Smoke', 5, 'IN_STOCK');
    expect(pickDefaultVariant([a, b])).toBe(b);
  });

  it('falls back to AVAILABLE_FROM_SUPPLIER when no IN_STOCK variant exists', () => {
    const a = v('a', 'Amber', 0, 'OUT_OF_STOCK');
    const b = v('b', 'Smoke', 0, 'AVAILABLE_FROM_SUPPLIER');
    const c = v('c', 'Sand', 0, 'OUT_OF_STOCK');
    expect(pickDefaultVariant([a, b, c])).toBe(b);
  });

  it('uses availableQty as the back-compat signal when stockState is absent', () => {
    const a = v('a', 'Amber', 0); // no stockState — back-compat OOS
    const b = v('b', 'Smoke', 3); // no stockState — back-compat IN_STOCK
    expect(pickDefaultVariant([a, b])).toBe(b);
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

describe('variantCeilingGbp / variantFloorGbp', () => {
  it('returns the ceiling when the variant slides', () => {
    expect(variantCeilingGbp({ priceGbp: '10.00', maxPriceGbp: '20.00' })).toBe(20);
    expect(variantFloorGbp({ priceGbp: '10.00' })).toBe(10);
  });

  it('falls back to the floor when there is no ceiling', () => {
    // A product that does not slide has one price, which is both ends.
    expect(variantCeilingGbp({ priceGbp: '6.00', maxPriceGbp: null })).toBe(6);
    expect(variantCeilingGbp({ priceGbp: '6.00' })).toBe(6);
  });

  it('returns null when the variant has no price at all', () => {
    expect(variantCeilingGbp({ priceGbp: null, maxPriceGbp: null })).toBeNull();
    expect(variantFloorGbp({ priceGbp: null })).toBeNull();
  });

  it('returns null rather than NaN for an unparseable price', () => {
    // NaN would silently pass the `> maxPrice` comparison as false and leave
    // the product visible at every filter setting.
    expect(variantCeilingGbp({ priceGbp: 'n/a', maxPriceGbp: null })).toBeNull();
    expect(variantFloorGbp({ priceGbp: '' })).toBeNull();
  });
});

describe('colourLinks', () => {
  const v = (colour: string | null, slug: string | null, stockState: 'IN_STOCK' | 'AVAILABLE_FROM_SUPPLIER' | 'OUT_OF_STOCK' = 'IN_STOCK') => ({
    colour,
    slug,
    stockState,
    availableQty: stockState === 'IN_STOCK' ? 5 : 0,
  });

  it('links each colour to its own product page, in the order given', () => {
    expect(
      colourLinks({ slug: 'landau-tpu-95a', variants: [v('Black', 'tpu-black'), v('White', 'tpu-white')] }),
    ).toEqual([
      { colour: 'Black', href: '/shop/p/tpu-black', inStock: true },
      { colour: 'White', href: '/shop/p/tpu-white', inStock: true },
    ]);
  });

  it('lists out-of-stock colours too, marked as such', () => {
    // A sold-out colour still belongs on the list: the customer should learn
    // the range carries it rather than assume it does not exist.
    const links = colourLinks({ slug: 'g', variants: [v('Clear', 'tpu-clear', 'OUT_OF_STOCK')] });
    expect(links).toEqual([{ colour: 'Clear', href: '/shop/p/tpu-clear', inStock: false }]);
  });

  it('counts supplier stock as in stock', () => {
    const links = colourLinks({ slug: 'g', variants: [v('Red', 'r', 'AVAILABLE_FROM_SUPPLIER')] });
    expect(links[0]!.inStock).toBe(true);
  });

  it('falls back to the group colour toggle when a variant has no slug', () => {
    const links = colourLinks({ slug: 'landau-pla', variants: [v('Sky Blue', null)] });
    expect(links[0]!.href).toBe('/shop/landau-pla?colour=Sky%20Blue');
  });

  it('gives no link when neither variant nor group has a slug', () => {
    expect(colourLinks({ slug: null, variants: [v('Grey', null)] })[0]!.href).toBeNull();
  });

  it('skips variants with no colour', () => {
    expect(colourLinks({ slug: 'g', variants: [v(null, 'x'), v('  ', 'y')] })).toEqual([]);
  });

  it('merges variants sharing a colour, in stock if either is', () => {
    const links = colourLinks({
      slug: 'g',
      variants: [v('Black', null, 'OUT_OF_STOCK'), v('black', 'black-2', 'IN_STOCK')],
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({ colour: 'Black', href: '/shop/p/black-2', inStock: true });
  });
});
