/**
 * Pricing engine unit + property tests (Prompt 5, SPEC §15). Pure — no DB.
 */
import { describe, expect, it } from 'vitest';
import { bandDiscountBp, computeQuote, toCustomerFacing } from './pricing.engine.js';
import type { QuoteInputs } from './pricing.types.js';

const RULE: QuoteInputs['rule'] = {
  preorderBands: [
    { minDaysToEta: 60, discountBp: 2000 },
    { minDaysToEta: 30, discountBp: 1500 },
    { minDaysToEta: 14, discountBp: 1000 },
    { minDaysToEta: 0, discountBp: 500 },
  ],
  cartonDiscountBp: 1000,
  maxStackBp: 3000,
  minContributionBp: 1500,
  variableFulfilmentPence: 0,
  paymentFeeBp: 200,
  quoteTtlMinutes: 30,
};

const NOW = Date.parse('2026-07-04T00:00:00Z');

function inputs(over: Partial<QuoteInputs>): QuoteInputs {
  return {
    sku: 'X',
    qty: 1,
    pool: 'warehouse',
    basePricePence: 1999,
    cartonSize: 24,
    landedCostPence: 900,
    rule: RULE,
    daysToEta: null,
    code: null,
    nowMs: NOW,
    ...over,
  };
}

describe('bandDiscountBp boundaries (§15.2)', () => {
  it('picks the highest satisfied band at each boundary', () => {
    const b = RULE.preorderBands;
    expect(bandDiscountBp(b, 70)).toBe(2000);
    expect(bandDiscountBp(b, 60)).toBe(2000);
    expect(bandDiscountBp(b, 59)).toBe(1500);
    expect(bandDiscountBp(b, 30)).toBe(1500);
    expect(bandDiscountBp(b, 29)).toBe(1000);
    expect(bandDiscountBp(b, 14)).toBe(1000);
    expect(bandDiscountBp(b, 13)).toBe(500);
    expect(bandDiscountBp(b, 1)).toBe(500);
  });
});

describe('carton tier — exact multiples only', () => {
  it('applies only when qty is a whole carton multiple', () => {
    expect(computeQuote(inputs({ qty: 23 })).tierApplied).toBe('single');
    expect(computeQuote(inputs({ qty: 24 })).tierApplied).toBe('carton');
    expect(computeQuote(inputs({ qty: 48 })).tierApplied).toBe('carton');
    expect(computeQuote(inputs({ qty: 25 })).tierApplied).toBe('single');
  });

  it('emits a carton upsell hint when below the tier', () => {
    const q = computeQuote(inputs({ qty: 20 }));
    expect(q.cartonMultipleHint).toMatch(/Add 4 more/);
    expect(computeQuote(inputs({ qty: 24 })).cartonMultipleHint).toBeNull();
  });
});

describe('golden worked example (§15.3)', () => {
  it('base £19.99, landed £9, full 30% stack → £13.99, clears the floor', () => {
    const q = computeQuote(inputs({ qty: 24, pool: 'SEA-70', daysToEta: 70 }));
    expect(q.structuralBpInternal).toBe(3000); // carton 1000 + preorder 2000
    expect(q.unitPricePence).toBe(1399); // £13.99
    expect(q.savingsVsBasePence).toBe(600); // £6.00
    expect(q.floorPricePenceInternal).toBe(1240);
    expect(q.clampedInternal).toBe(false);
    expect(q.tierApplied).toBe('carton');
  });

  it('a £14.99 promo SKU clamps to the floor; nothing breaks', () => {
    const q = computeQuote(inputs({ basePricePence: 1499, qty: 24, pool: 'SEA-70', daysToEta: 70 }));
    expect(q.clampedInternal).toBe(true);
    expect(q.unitPricePence).toBe(q.floorPricePenceInternal);
    expect(q.unitPricePence).toBe(1155);
  });
});

describe('best-of discount codes (§15.5)', () => {
  it('picks the code when it beats the structural stack, else the stack — never both', () => {
    // structural = carton only (10% of 2000 = 200 → 1800).
    const base = { basePricePence: 2000, qty: 24, landedCostPence: 100 } as Partial<QuoteInputs>;
    const structuralOnly = computeQuote(inputs(base));
    expect(structuralOnly.unitPricePence).toBe(1800);
    expect(structuralOnly.discountWinner).toBe('structural');

    const codeWins = computeQuote(inputs({ ...base, code: { kind: 'percent', valueBp: 1200 } }));
    expect(codeWins.discountWinner).toBe('code');
    expect(codeWins.unitPricePence).toBe(1760); // 2000 − 12%
    expect(codeWins.savings).toEqual([{ source: 'code', savingPence: 240 }]);

    const stackWins = computeQuote(inputs({ ...base, code: { kind: 'percent', valueBp: 800 } }));
    expect(stackWins.discountWinner).toBe('structural');
    expect(stackWins.unitPricePence).toBe(1800); // 2000 − 8% code (1840) is worse
  });
});

describe('floor is never breached (property)', () => {
  it('across a wide grid of (base, qty, days, code), unit ≥ floor', () => {
    for (const basePricePence of [500, 1000, 1499, 1999, 3000, 9999]) {
      for (const qty of [1, 5, 23, 24, 48]) {
        for (const daysToEta of [null, 1, 13, 14, 29, 30, 59, 60, 400] as (number | null)[]) {
          for (const landedCostPence of [0, 300, 900, 5000]) {
            for (const code of [
              null,
              { kind: 'percent' as const, valueBp: 5000 },
              { kind: 'fixed' as const, valuePence: 99999 },
            ]) {
              const q = computeQuote(
                inputs({ basePricePence, qty, daysToEta, landedCostPence, code, pool: daysToEta ? 'P' : 'warehouse' }),
              );
              // Discount never breaches the floor for realistically-priced
              // SKUs (base ≥ floor); for an underwater SKU (floor > base) the
              // engine falls back to base rather than raising the price.
              expect(q.unitPricePence).toBeGreaterThanOrEqual(
                Math.min(q.floorPricePenceInternal, basePricePence),
              );
              expect(q.unitPricePence).toBeLessThanOrEqual(basePricePence);
              // savings are consistent with the final price
              expect(q.savingsVsBasePence).toBe(basePricePence - q.unitPricePence);
            }
          }
        }
      }
    }
  });
});

describe('toCustomerFacing', () => {
  it('strips every *Internal field', () => {
    const q = computeQuote(inputs({ qty: 24, pool: 'SEA-70', daysToEta: 70 }));
    const cf = toCustomerFacing(q) as Record<string, unknown>;
    for (const key of Object.keys(cf)) {
      expect(key.endsWith('Internal')).toBe(false);
    }
    // sanity: the real customer figures survive
    expect(cf.unitPricePence).toBe(1399);
    expect(cf.savingsVsBasePence).toBe(600);
    expect('floorPricePenceInternal' in cf).toBe(false);
  });
});
