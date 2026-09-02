/**
 * Order-status mapping and lookup-budget tests.
 *
 * The status mapping is the part a customer reads, and getting it wrong
 * means telling someone their order was delivered when it wasn't. The
 * budget is the enumeration speed bump on the anonymous lookup. Both are
 * pure enough to test without a database; the query paths themselves are
 * covered by the integration suite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  toCustomerStatus,
  statusText,
  _resetLookupBudget,
  type CustomerFacingStatus,
} from './order-status.service.js';

afterEach(() => _resetLookupBudget());

describe('toCustomerStatus', () => {
  it('maps warehouse picking states to preparing', () => {
    for (const s of ['ALLOCATED', 'PARTIALLY_ALLOCATED', 'BACK_ORDERED', 'READY_TO_SHIP']) {
      expect(toCustomerStatus(s, null), s).toBe('preparing');
    }
  });

  it('maps freshly-placed states to placed', () => {
    expect(toCustomerStatus('DRAFT', null)).toBe('placed');
    expect(toCustomerStatus('CONFIRMED', null)).toBe('placed');
  });

  it('maps both shipped states to shipped', () => {
    expect(toCustomerStatus('SHIPPED', '2026-05-14')).toBe('shipped');
    expect(toCustomerStatus('PARTIALLY_SHIPPED', '2026-05-14')).toBe('shipped');
  });

  it('treats INVOICED and COMPLETED with a dispatch date as delivered', () => {
    expect(toCustomerStatus('INVOICED', '2026-05-10')).toBe('delivered');
    expect(toCustomerStatus('COMPLETED', '2026-05-10')).toBe('delivered');
  });

  it('does NOT claim delivery for a paperwork close with no dispatch date', () => {
    // A completed order that never shipped is a billing state, not a
    // delivery. Telling the customer it arrived would be a lie they'd
    // have to argue with.
    expect(toCustomerStatus('COMPLETED', null)).toBe('preparing');
    expect(toCustomerStatus('INVOICED', null)).toBe('preparing');
  });

  it('passes cancelled and on-hold through distinctly', () => {
    expect(toCustomerStatus('CANCELLED', null)).toBe('cancelled');
    expect(toCustomerStatus('ON_HOLD', null)).toBe('on_hold');
  });

  it('defaults an unrecognised internal status to preparing, not delivered', () => {
    // A status added later must never accidentally read as "arrived".
    expect(toCustomerStatus('SOME_NEW_STATE', null)).toBe('preparing');
    expect(toCustomerStatus('SOME_NEW_STATE', '2026-05-10')).toBe('preparing');
  });

  it('never leaks an internal status name', () => {
    const allowed: CustomerFacingStatus[] = [
      'placed',
      'preparing',
      'shipped',
      'delivered',
      'cancelled',
      'on_hold',
    ];
    const internals = [
      'DRAFT', 'CONFIRMED', 'ALLOCATED', 'PARTIALLY_ALLOCATED', 'BACK_ORDERED',
      'READY_TO_SHIP', 'PARTIALLY_SHIPPED', 'SHIPPED', 'INVOICED', 'COMPLETED',
      'CANCELLED', 'ON_HOLD',
    ];
    for (const s of internals) {
      expect(allowed, s).toContain(toCustomerStatus(s, '2026-01-01'));
    }
  });
});

describe('statusText', () => {
  it('mentions tracking only when there is tracking', () => {
    expect(statusText('shipped', true)).toMatch(/tracking/i);
    expect(statusText('shipped', false)).not.toMatch(/tracking/i);
  });

  it('gives a usable sentence for every status', () => {
    const statuses: CustomerFacingStatus[] = [
      'placed',
      'preparing',
      'shipped',
      'delivered',
      'cancelled',
      'on_hold',
    ];
    for (const s of statuses) {
      const text = statusText(s, false);
      expect(text.length, s).toBeGreaterThan(5);
      expect(text.endsWith('.'), s).toBe(true);
    }
  });

  it('does not promise a delivery date anywhere', () => {
    // The specialist is told not to estimate dates; the canned text
    // must not undercut that by implying one.
    const statuses: CustomerFacingStatus[] = [
      'placed', 'preparing', 'shipped', 'delivered', 'cancelled', 'on_hold',
    ];
    for (const s of statuses) {
      for (const hasTracking of [true, false]) {
        expect(statusText(s, hasTracking).toLowerCase()).not.toMatch(
          /tomorrow|working day|by \w+day|within \d/,
        );
      }
    }
  });
});
