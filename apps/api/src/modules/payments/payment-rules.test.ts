/**
 * Payment-timing rule tests (Prompt 6, SPEC §16.1). Pure.
 */
import { describe, expect, it } from 'vitest';
import { isBankOnlyOrder, offeredMethods, isMethodAllowed, FULL_METHOD_SET } from './payment-rules.js';

describe('>30-day bank-only rule', () => {
  it('is bank-only when ANY line exceeds 30 days; boundary at exactly 30 is full', () => {
    expect(isBankOnlyOrder([{ daysToEta: 30 }])).toBe(false); // exactly 30 → full set
    expect(isBankOnlyOrder([{ daysToEta: 31 }])).toBe(true);
    expect(isBankOnlyOrder([{ daysToEta: null }])).toBe(false); // warehouse
    expect(isBankOnlyOrder([{ daysToEta: 10 }, { daysToEta: 45 }])).toBe(true); // any line
    expect(isBankOnlyOrder([{ daysToEta: 10 }, { daysToEta: 20 }])).toBe(false);
  });

  it('offers the full set ≤30 days and bank-only beyond', () => {
    expect(offeredMethods([{ daysToEta: 30 }])).toEqual(FULL_METHOD_SET);
    expect(offeredMethods([{ daysToEta: 31 }])).toEqual(['banktransfer']);
  });

  it('rejects card methods on a bank-only order', () => {
    const bankOnly = [{ daysToEta: 60 }];
    expect(isMethodAllowed('creditcard', bankOnly)).toBe(false);
    expect(isMethodAllowed('applepay', bankOnly)).toBe(false);
    expect(isMethodAllowed('paypal', bankOnly)).toBe(false);
    expect(isMethodAllowed('banktransfer', bankOnly)).toBe(true);
    // ≤30 days: cards fine
    expect(isMethodAllowed('creditcard', [{ daysToEta: 20 }])).toBe(true);
  });
});
