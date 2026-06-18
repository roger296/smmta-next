/**
 * Units-of-measure helpers (P3, spec §A3). Pure unit tests — no DB.
 */
import { describe, expect, it } from 'vitest';
import {
  assertValidStockQty,
  ceilToQuantum,
  FractionalDiscreteQtyError,
  isDiscreteStockUom,
  isValidStockQty,
  purchaseToStock,
  roundToQuantum,
  roundUpToPackMultiple,
  stockToPurchase,
} from './uom.js';

describe('UoM conversions', () => {
  it('converts purchase→stock and back (round-trip)', () => {
    // 1 bag = 1000 g.
    expect(purchaseToStock(3, 1000)).toBe(3000);
    expect(stockToPurchase(3000, 1000)).toBe(3);
    // Fractional bags round-trip exactly.
    expect(purchaseToStock(2.5, 2000)).toBe(5000);
    expect(stockToPurchase(5000, 2000)).toBe(2.5);
  });

  it('throws when the factor is zero', () => {
    expect(() => stockToPurchase(100, 0)).toThrow(RangeError);
  });

  it('rounds an order quantity up to a whole pack multiple', () => {
    expect(roundUpToPackMultiple(7, 6)).toBe(12); // two cases of 6
    expect(roundUpToPackMultiple(12, 6)).toBe(12); // exact
    expect(roundUpToPackMultiple(1, 6)).toBe(6);
    expect(roundUpToPackMultiple(5, 1)).toBe(5); // pack size 1 = no rounding
  });
});

describe('quantum bucketing', () => {
  it('rounds to the nearest ~100 g quantum', () => {
    expect(roundToQuantum(1234)).toBe(1200);
    expect(roundToQuantum(1250)).toBe(1300); // .5 rounds up
    expect(roundToQuantum(40)).toBe(0);
    expect(roundToQuantum(60)).toBe(100);
  });

  it('ceils to a quantum for reorder (never under-buys)', () => {
    expect(ceilToQuantum(1201)).toBe(1300);
    expect(ceilToQuantum(1200)).toBe(1200);
    expect(ceilToQuantum(1, 50)).toBe(50);
  });
});

describe('discrete vs fungible units', () => {
  it('classifies discrete units', () => {
    expect(isDiscreteStockUom('each')).toBe(true);
    expect(isDiscreteStockUom('EA')).toBe(true);
    expect(isDiscreteStockUom('unit')).toBe(true);
    expect(isDiscreteStockUom('g')).toBe(false);
    expect(isDiscreteStockUom('ml')).toBe(false);
  });

  it('rejects a fractional quantity for a discrete unit', () => {
    expect(() => assertValidStockQty('each', 2.5)).toThrow(FractionalDiscreteQtyError);
    expect(isValidStockQty('each', 2.5)).toBe(false);
    // Whole units are fine.
    expect(() => assertValidStockQty('each', 3)).not.toThrow();
    expect(isValidStockQty('each', 3)).toBe(true);
    // Fungible units accept fractions.
    expect(() => assertValidStockQty('g', 250.5)).not.toThrow();
    expect(isValidStockQty('g', 250.5)).toBe(true);
  });
});
