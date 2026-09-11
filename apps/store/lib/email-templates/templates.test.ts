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
  const THANKS =
    'Thanks for your order, we appreciate all of our customers and we hope to see you again soon.';
  const recommendations = [
    {
      groupId: 'g-silk',
      name: 'Landau PLA Silk 1.75mm 1kg',
      path: '/shop/landau-pla-silk-1-75mm-1kg',
      imageUrl: 'https://img.example/silk.jpg',
      priceFrom: '£14.99',
      eyebrow: 'Your next PLA',
      blurb: 'High-gloss, near-metallic sheen.',
      material: 'PLA',
    },
    {
      groupId: 'g-tpu',
      name: 'Landau TPU 95A 1.75mm 1kg',
      path: '/shop/landau-tpu-95a-1-75mm-1kg',
      imageUrl: '/uploads/tpu.jpg',
      priceFrom: '£19.99',
      eyebrow: 'Try TPU',
      blurb: 'Flexible 95A.',
      material: 'TPU',
    },
  ];

  it('says who it shipped with and the tracking number, and thanks the customer', () => {
    const r = renderTemplate('order_shipped', {
      orderId: 'ord-2',
      orderNumber: 'STORE-SHIP1',
      firstName: 'Pat',
      storeBaseUrl: STORE,
      courierName: 'DPD',
      trackingNumber: '15503215399048',
      trackingLink: 'https://app.smoothparcel.com/trackmyshipments/15503215399048',
      shippedDate: '11 September 2026',
    });
    expect(r.subject).toMatch(/STORE-SHIP1/);
    expect(r.preheader).toContain('DPD');
    expect(r.preheader.length).toBeLessThan(120);
    expect(r.text).toContain('Your order shipped with DPD and the tracking number is 15503215399048.');
    expect(r.html).toContain('Your order shipped with <strong>DPD</strong> and the tracking number is');
    expect(r.html).toContain('https://app.smoothparcel.com/trackmyshipments/15503215399048');
    expect(r.html).toContain('Track your parcel');
    expect(r.html).toContain('Pat');
    expect(r.html).toContain(THANKS);
    expect(r.text).toContain(THANKS);
    expect(r.text).toContain(`${STORE}/track/ord-2`);
    // Its coloured bands run edge to edge, so the body is not padded.
    expect(r.html).toContain('padding:0;font-size:15px');
  });

  it('names the courier when there is no tracking number', () => {
    const r = renderTemplate('order_shipped', {
      orderId: 'ord-2',
      orderNumber: 'STORE-NONUMBER',
      storeBaseUrl: STORE,
      courierName: 'DPD',
    });
    expect(r.text).toContain('Your order shipped with DPD.');
  });

  it('still renders without tracking or courier', () => {
    const r = renderTemplate('order_shipped', {
      orderId: 'ord-2',
      orderNumber: 'STORE-NOTRACK',
      storeBaseUrl: STORE,
    });
    expect(r.html).toContain('STORE-NOTRACK');
    expect(r.text).toContain('Your order shipped.');
    expect(r.text).not.toContain('tracking number');
    expect(r.html).not.toContain('Track your parcel');
    expect(r.html).not.toContain('VAT invoice');
  });

  it('advertises the ranges picked for the customer and both stores', () => {
    const r = renderTemplate('order_shipped', {
      orderId: 'ord-2',
      orderNumber: 'STORE-ADS',
      storeBaseUrl: STORE,
      recommendations,
      invoiceAvailable: true,
    });
    expect(r.html).toContain(`${STORE}/shop/landau-pla-silk-1-75mm-1kg`);
    expect(r.html).toContain('https://img.example/silk.jpg');
    // A relative image cannot load in a mail client, so it is left out.
    expect(r.html).not.toContain('/uploads/tpu.jpg');
    expect(r.html).toContain('Try TPU');
    expect(r.html).toContain('From £14.99');
    expect(r.html).toContain('https://clothes.cleverdeals.net');
    expect(r.html).toContain('Clothes Shop');
    expect(r.html).toContain('VAT invoice');
    expect(r.text).toContain(`${STORE}/shop/landau-tpu-95a-1-75mm-1kg`);
    expect(r.text).toContain('https://clothes.cleverdeals.net');
  });

  it('escapes names that come from the catalogue', () => {
    const r = renderTemplate('order_shipped', {
      orderId: 'ord-2',
      orderNumber: 'STORE-ESC',
      storeBaseUrl: STORE,
      recommendations: [{ ...recommendations[0]!, name: 'PLA <script>alert(1)</script>' }],
    });
    expect(r.html).not.toContain('<script>');
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
