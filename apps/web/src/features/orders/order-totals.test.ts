/**
 * Order summary tile labels must be true to how the figures were stored.
 *
 * Storefront orders store goods and delivery including VAT; orders created in
 * the admin store goods excluding VAT and add tax on top. A single "inc Tax"
 * label would be false for the second kind, so these pin both.
 */
import { describe, expect, it } from 'vitest';
import { orderTotalLabels, totalsIncludeTax } from './order-totals';

describe('totalsIncludeTax', () => {
  it('recognises a storefront order, where the tax is inside goods and delivery', () => {
    // The live test order: 2 x Basic PLA Brown. 24.56 + 4.95 = 29.51, and the
    // 4.91 of VAT is already inside those two figures.
    expect(
      totalsIncludeTax({ orderTotal: '24.56', deliveryCharge: '4.95', taxTotal: '4.91', grandTotal: '29.51' }),
    ).toBe(true);
  });

  it('recognises an admin order, where tax is added on top of goods', () => {
    // 50 goods + 20% tax (10) + 0 delivery = 60 — the admin order form's sum.
    expect(
      totalsIncludeTax({ orderTotal: '50.00', deliveryCharge: '0', taxTotal: '10.00', grandTotal: '60.00' }),
    ).toBe(false);
  });

  it('recognises an admin order with untaxed delivery', () => {
    expect(
      totalsIncludeTax({ orderTotal: '50.00', deliveryCharge: '5.00', taxTotal: '10.00', grandTotal: '65.00' }),
    ).toBe(false);
  });

  it('tolerates a penny of independent rounding', () => {
    expect(
      totalsIncludeTax({ orderTotal: '24.56', deliveryCharge: '4.95', taxTotal: '4.91', grandTotal: '29.52' }),
    ).toBe(true);
  });

  it('treats a zero-tax order as inclusive, since both readings agree', () => {
    expect(
      totalsIncludeTax({ orderTotal: '12.00', deliveryCharge: '3.00', taxTotal: '0', grandTotal: '15.00' }),
    ).toBe(true);
  });

  it('accepts numbers as well as decimal strings', () => {
    expect(totalsIncludeTax({ orderTotal: 50, deliveryCharge: 0, taxTotal: 10, grandTotal: 60 })).toBe(false);
  });
});

describe('orderTotalLabels', () => {
  it('uses the inc-tax titles for a storefront order', () => {
    expect(
      orderTotalLabels({ orderTotal: '24.56', deliveryCharge: '4.95', taxTotal: '4.91', grandTotal: '29.51' }),
    ).toEqual({ goods: 'Goods Total (inc Tax)', delivery: 'Delivery (inc Tax)' });
  });

  it('does not claim tax is included on an admin order', () => {
    expect(
      orderTotalLabels({ orderTotal: '50.00', deliveryCharge: '5.00', taxTotal: '10.00', grandTotal: '65.00' }),
    ).toEqual({ goods: 'Goods Total (ex Tax)', delivery: 'Delivery' });
  });
});
