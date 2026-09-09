/**
 * Volume pricing arithmetic.
 *
 * Lives in apps/api because that workspace already has vitest wired up and
 * depends on @smmta/shared-types. The function under test is pure, so it needs
 * no database and runs in milliseconds.
 *
 * The properties asserted here are the ones that keep the storefront and the
 * API agreeing to the penny. A drift between them fails every checkout at the
 * Mollie reconciliation guard, so these are worth more than their size.
 */
import { describe, expect, it } from 'vitest';
import {
  VOLUME_PRICE_BEST_QTY,
  priceBandPence,
  tieredUnitPricePence,
} from '@smmta/shared-types';

// The real numbers for V3-PLA-REG-GREEN: £4.62 min, doubled to £9.24 max.
const MIN = 462;
const MAX = 924;

describe('tieredUnitPricePence', () => {
  it('charges the max price for a single unit', () => {
    expect(tieredUnitPricePence(MIN, MAX, 1)).toBe(MAX);
  });

  it('charges the min price at the best-price quantity, exactly', () => {
    expect(tieredUnitPricePence(MIN, MAX, VOLUME_PRICE_BEST_QTY)).toBe(MIN);
  });

  it('stays at the min price beyond the best-price quantity', () => {
    for (const qty of [11, 12, 50, 99]) {
      expect(tieredUnitPricePence(MIN, MAX, qty)).toBe(MIN);
    }
  });

  it('decreases monotonically as the basket grows', () => {
    let previous = Infinity;
    for (let qty = 1; qty <= 15; qty++) {
      const price = tieredUnitPricePence(MIN, MAX, qty);
      expect(price).toBeLessThanOrEqual(previous);
      previous = price;
    }
  });

  it('never falls below the min or rises above the max', () => {
    for (let qty = 0; qty <= 20; qty++) {
      const price = tieredUnitPricePence(MIN, MAX, qty);
      expect(price).toBeGreaterThanOrEqual(MIN);
      expect(price).toBeLessThanOrEqual(MAX);
    }
  });

  it('treats a quantity below one as a single unit', () => {
    // A zero or negative quantity is a caller bug, but it must not produce a
    // price below the max — that would be a discount granted by accident.
    for (const qty of [0, -1, -100]) {
      expect(tieredUnitPricePence(MIN, MAX, qty)).toBe(MAX);
    }
  });

  it('ignores a fractional quantity rather than interpolating', () => {
    expect(tieredUnitPricePence(MIN, MAX, 2.9)).toBe(tieredUnitPricePence(MIN, MAX, 2));
  });

  it('returns whole pence for every quantity', () => {
    for (let qty = 1; qty <= VOLUME_PRICE_BEST_QTY; qty++) {
      expect(Number.isInteger(tieredUnitPricePence(MIN, MAX, qty))).toBe(true);
    }
  });

  it('is deterministic — the property the two call sites depend on', () => {
    // Same inputs must give the same output every time, for any price pair.
    // If this ever failed, the storefront and the API could compute different
    // totals for one basket and every checkout would be rejected.
    for (let min = 1; min <= 2000; min += 137) {
      for (let max = min; max <= min * 3; max += 91) {
        for (let qty = 1; qty <= 12; qty++) {
          const a = tieredUnitPricePence(min, max, qty);
          const b = tieredUnitPricePence(min, max, qty);
          expect(a).toBe(b);
          expect(a).toBeGreaterThanOrEqual(min);
        }
      }
    }
  });

  describe('products that do not slide', () => {
    it('stays at the min price when there is no max', () => {
      for (const max of [null, undefined]) {
        expect(tieredUnitPricePence(MIN, max, 1)).toBe(MIN);
        expect(tieredUnitPricePence(MIN, max, 20)).toBe(MIN);
      }
    });

    it('stays at the min price when max equals min', () => {
      // The state every product was in before this feature. Volume pricing
      // must be a no-op for them rather than inventing a discount.
      expect(tieredUnitPricePence(MIN, MIN, 1)).toBe(MIN);
      expect(tieredUnitPricePence(MIN, MIN, 10)).toBe(MIN);
    });

    it('does not discount below the min when max is inverted', () => {
      // Bad data: a max lower than the min. Charging below the min would be
      // selling under the floor price, so it clamps instead.
      expect(tieredUnitPricePence(MIN, 100, 1)).toBe(MIN);
      expect(tieredUnitPricePence(MIN, 100, 10)).toBe(MIN);
    });
  });

  it('handles an odd spread that does not divide evenly', () => {
    // 463 - 100 = 363, which is not divisible by 9. The endpoints must still
    // be exact; only the middle is rounded.
    expect(tieredUnitPricePence(100, 463, 1)).toBe(463);
    expect(tieredUnitPricePence(100, 463, VOLUME_PRICE_BEST_QTY)).toBe(100);
  });
});

describe('priceBandPence', () => {
  it('reports the sliding band for a product with a max', () => {
    expect(priceBandPence(MIN, MAX)).toEqual({
      fromPence: MIN,
      toPence: MAX,
      slides: true,
    });
  });

  it('reports a flat band, not a range, when the product does not slide', () => {
    expect(priceBandPence(MIN, null)).toEqual({
      fromPence: MIN,
      toPence: MIN,
      slides: false,
    });
  });
});
