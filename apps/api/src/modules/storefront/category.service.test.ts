/**
 * Unit tests for the pure helpers in `category.service.ts`. The
 * stateful methods (`listNav`, `listCategoryProducts`) need a real
 * Postgres connection and are covered by the integration suite —
 * here we lock the facet-computation and price-parsing logic that
 * the route layer relies on.
 */
import { describe, expect, it } from 'vitest';
import { computeFacets } from './category.service.js';

describe('computeFacets', () => {
  it('returns empty maps + null priceRange for an empty input', () => {
    const f = computeFacets([]);
    expect(f.brand).toEqual({});
    expect(f.colour).toEqual({});
    expect(f.size).toEqual({});
    expect(f.stockState).toEqual({
      IN_STOCK: 0,
      AVAILABLE_FROM_SUPPLIER: 0,
      OUT_OF_STOCK: 0,
    });
    expect(f.priceRange).toBeNull();
  });

  it('counts brand / colour / size occurrences', () => {
    const f = computeFacets([
      { brand: 'Russell', colour: 'Black', priceGbp: '10.00', stockState: 'IN_STOCK', attributes: { size: 'M' } },
      { brand: 'Russell', colour: 'Black', priceGbp: '12.00', stockState: 'IN_STOCK', attributes: { size: 'L' } },
      { brand: 'Stedman', colour: 'Navy', priceGbp: '8.00', stockState: 'AVAILABLE_FROM_SUPPLIER', attributes: { size: 'M' } },
      { brand: null, colour: null, priceGbp: null, stockState: 'OUT_OF_STOCK', attributes: null },
    ]);
    expect(f.brand).toEqual({ Russell: 2, Stedman: 1 });
    expect(f.colour).toEqual({ Black: 2, Navy: 1 });
    expect(f.size).toEqual({ M: 2, L: 1 });
    expect(f.stockState).toEqual({
      IN_STOCK: 2,
      AVAILABLE_FROM_SUPPLIER: 1,
      OUT_OF_STOCK: 1,
    });
  });

  it('computes priceRange across non-null prices only', () => {
    const f = computeFacets([
      { brand: null, colour: null, priceGbp: '5.00', stockState: 'IN_STOCK', attributes: null },
      { brand: null, colour: null, priceGbp: '50.00', stockState: 'IN_STOCK', attributes: null },
      { brand: null, colour: null, priceGbp: null, stockState: 'IN_STOCK', attributes: null },
      { brand: null, colour: null, priceGbp: 'not-a-number', stockState: 'IN_STOCK', attributes: null },
    ]);
    expect(f.priceRange).toEqual({ min: '5.00', max: '50.00' });
  });

  it('priceRange null when no parseable prices', () => {
    const f = computeFacets([
      { brand: null, colour: null, priceGbp: null, stockState: 'IN_STOCK', attributes: null },
      { brand: null, colour: null, priceGbp: 'nope', stockState: 'IN_STOCK', attributes: null },
    ]);
    expect(f.priceRange).toBeNull();
  });

  it('skips facet bumps when value is null/missing', () => {
    const f = computeFacets([
      { brand: null, colour: null, priceGbp: null, stockState: 'IN_STOCK', attributes: { size: '' } },
    ]);
    expect(f.brand).toEqual({});
    expect(f.colour).toEqual({});
    // empty-string size is falsy → not bumped.
    expect(f.size).toEqual({});
  });
});
