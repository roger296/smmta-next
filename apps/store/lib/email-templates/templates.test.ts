/**
 * Pure-function tests for the four transactional email templates.
 * No DOM, no SendGrid. Verifies subject lines, that html + text + preheader
 * are populated, and that key payload fields appear verbatim.
 */
import { describe, expect, it } from 'vitest';
import { renderTemplate } from './index';

const STORE = 'https://store.example.com';

describe('order_confirmation', () => {
  it('renders subject, html, text, and preheader', () => {
    const r = renderTemplate('order_confirmation', {
      orderId: 'ord-1',
      orderNumber: 'STORE-ABCDEF',
      firstName: 'Pat',
      grandTotal: '28.95',
      currency: 'GBP',
      storeBaseUrl: STORE,
      lines: [{ name: 'Aurora Smoke', qty: 2, lineTotal: '24.00' }],
      shippingAddress: { line1: '12 Test', city: 'London', postCode: 'SW1A 1AA' },
    });
    expect(r.subject).toMatch(/STORE-ABCDEF/);
    expect(r.preheader.length).toBeGreaterThan(0);
    expect(r.preheader.length).toBeLessThan(120);
    expect(r.html).toContain('STORE-ABCDEF');
    expect(r.html).toContain('Pat');
    expect(r.html).toContain('£28.95');
    // Tracking link points at /track/[orderId]
    expect(r.html).toContain(`${STORE}/track/ord-1`);
    expect(r.text).toContain('STORE-ABCDEF');
    expect(r.text).toContain(`${STORE}/track/ord-1`);
  });

  it('falls back gracefully when firstName + lines + address are missing', () => {
    const r = renderTemplate('order_confirmation', {
      orderId: 'ord-1',
      orderNumber: 'STORE-XYZ',
      grandTotal: '5.00',
      currency: 'GBP',
      storeBaseUrl: STORE,
    });
    expect(r.html).toContain('Hi there'); // no firstName
    expect(r.text).toContain('Hi there');
    expect(r.html).toContain('£5.00');
  });

  it('escapes HTML in customer-controlled fields', () => {
    const r = renderTemplate('order_confirmation', {
      orderId: 'ord-1',
      orderNumber: 'STORE-XSS',
      firstName: '<script>alert(1)</script>',
      grandTotal: '10.00',
      currency: 'GBP',
      storeBaseUrl: STORE,
    });
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });
});

describe('order_shipped', () => {
  it('mentions tracking number + courier when present', () => {
    const r = renderTemplate('order_shipped', {
      orderId: 'ord-2',
      orderNumber: 'STORE-SHIP1',
      firstName: 'Pat',
      storeBaseUrl: STORE,
      courierName: 'Royal Mail',
      trackingNumber: 'AA123456789GB',
      trackingLink: 'https://royalmail.example/track/AA123',
      shippedDate: '2026-04-28',
    });
    expect(r.subject).toMatch(/STORE-SHIP1/);
    expect(r.html).toContain('AA123456789GB');
    expect(r.html).toContain('Royal Mail');
    expect(r.html).toContain('https://royalmail.example/track/AA123');
    expect(r.text).toContain('AA123456789GB');
  });

  it('still renders without tracking', () => {
    const r = renderTemplate('order_shipped', {
      orderId: 'ord-2',
      orderNumber: 'STORE-NOTRACK',
      storeBaseUrl: STORE,
    });
    expect(r.html).toContain('STORE-NOTRACK');
    expect(r.text).not.toContain('Tracking number:');
  });
});

describe('order_cancelled', () => {
  it('includes the cancellation reason when supplied', () => {
    const r = renderTemplate('order_cancelled', {
      orderId: 'ord-3',
      orderNumber: 'STORE-CXL',
      firstName: 'Pat',
      storeBaseUrl: STORE,
      reason: 'Stock unavailable',
    });
    expect(r.subject).toMatch(/STORE-CXL/);
    expect(r.html).toContain('Stock unavailable');
    expect(r.text).toContain('Stock unavailable');
  });
});

describe('refund_issued', () => {
  it('renders the refund amount and reference', () => {
    const r = renderTemplate('refund_issued', {
      orderId: 'ord-4',
      orderNumber: 'STORE-REF',
      firstName: 'Pat',
      storeBaseUrl: STORE,
      refundAmount: '12.50',
      currency: 'GBP',
      refundId: 're_test_123',
    });
    expect(r.subject).toMatch(/STORE-REF/);
    expect(r.html).toContain('£12.50');
    expect(r.html).toContain('re_test_123');
    expect(r.text).toContain('£12.50');
  });
});

describe('renderTemplate dispatch', () => {
  it('throws on an unknown template at runtime', () => {
    // Cast through unknown so we can simulate a stale DB row at runtime.
    expect(() =>
      renderTemplate(
        'nope' as unknown as 'order_confirmation',
        {
          orderId: 'x',
          orderNumber: 'x',
          grandTotal: '0',
          currency: 'GBP',
          storeBaseUrl: STORE,
        },
      ),
    ).toThrow(/Unknown template/);
  });
});
