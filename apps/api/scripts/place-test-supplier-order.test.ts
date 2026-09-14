/**
 * Unit tests for the test-order script's safety rule: only Ralawise has a
 * test mode, so any other supplier needs --real before an order is sent.
 */
import { describe, expect, it } from 'vitest';
import { RALAWISE_TEST_REFERENCE, testOrderReference } from './place-test-supplier-order.js';

describe('testOrderReference', () => {
  it('always uses APITEST for Ralawise, even with --real', () => {
    expect(testOrderReference('RALAWISE', false)).toEqual({ reference: RALAWISE_TEST_REFERENCE, isReal: false });
    expect(testOrderReference('RALAWISE', true)).toEqual({ reference: 'APITEST', isReal: false });
  });

  it('refuses a supplier with no test mode unless --real is given', () => {
    expect(() => testOrderReference('UNEEK', false)).toThrow(/REAL order/);
  });

  it('gives a real order a short unique reference', () => {
    const r = testOrderReference('UNEEK', true, new Date('2026-09-14T18:00:00Z'));
    expect(r.isReal).toBe(true);
    expect(r.reference).toMatch(/^TEST-[0-9A-Z]+$/);
    expect(r.reference.length).toBeLessThanOrEqual(20);
  });
});
