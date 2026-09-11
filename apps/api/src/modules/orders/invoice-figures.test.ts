/**
 * Invoice figures from real order shapes. Pure — no database.
 */
import { describe, expect, it } from 'vitest';
import { invoiceFigures, totalsIncludeTax } from './invoice-figures.js';

describe('invoiceFigures — storefront order (VAT-inclusive prices)', () => {
  // Order STORE-EBE1CE630088 as the storefront stored it: 2 × £12.28 inc VAT,
  // £4.95 delivery inc VAT, tax total £4.91 (goods £4.09 + delivery £0.82),
  // charged £29.51.
  const order = { orderTotal: '24.56', taxTotal: '4.91', deliveryCharge: '4.95', grandTotal: '29.51' };
  const lines = [{ quantity: 2, lineTotal: '24.56', taxValue: '4.09', taxRate: 20 }];
  const f = invoiceFigures(order, lines);

  it('recognises the prices include VAT', () => {
    expect(totalsIncludeTax(order)).toBe(true);
    expect(f.pricesIncludeTax).toBe(true);
  });

  it('states the goods net of VAT', () => {
    expect(f.lines[0]).toMatchObject({ netPence: 2047, vatPence: 409, grossPence: 2456, unitNetPence: 1024 });
    expect(f.goodsNetPence).toBe(2047);
  });

  it('splits delivery into net and VAT', () => {
    expect(f.deliveryVatPence).toBe(82);
    expect(f.deliveryNetPence).toBe(413);
  });

  it('totals to exactly what the customer paid, not VAT added twice', () => {
    expect(f.totalNetPence).toBe(2460);
    expect(f.totalVatPence).toBe(491);
    expect(f.grossPence).toBe(2951);
    expect(f.reconciles).toBe(true);
  });
});

describe('invoiceFigures — admin order (VAT added on top)', () => {
  const order = { orderTotal: '20.00', taxTotal: '4.00', deliveryCharge: '5.00', grandTotal: '29.00' };
  const lines = [{ quantity: 2, lineTotal: '20.00', taxValue: '4.00', taxRate: 20 }];
  const f = invoiceFigures(order, lines);

  it('keeps the stored net prices and adds the VAT', () => {
    expect(f.pricesIncludeTax).toBe(false);
    expect(f.lines[0]).toMatchObject({ netPence: 2000, vatPence: 400, grossPence: 2400, unitNetPence: 1000 });
  });

  it('charges no VAT on delivery the order did not charge VAT on', () => {
    expect(f.deliveryNetPence).toBe(500);
    expect(f.deliveryVatPence).toBe(0);
    expect(f.grossPence).toBe(2900);
    expect(f.reconciles).toBe(true);
  });
});

describe('invoiceFigures — safety', () => {
  it('reports figures that do not reconcile with the order', () => {
    const f = invoiceFigures(
      { orderTotal: '20.00', taxTotal: '4.00', deliveryCharge: '0', grandTotal: '50.00' },
      [{ quantity: 1, lineTotal: '20.00', taxValue: '4.00', taxRate: 20 }],
    );
    expect(f.reconciles).toBe(false);
  });

  it('handles a zero-VAT order either way', () => {
    const f = invoiceFigures(
      { orderTotal: '10.00', taxTotal: '0', deliveryCharge: '0', grandTotal: '10.00' },
      [{ quantity: 1, lineTotal: '10.00', taxValue: '0', taxRate: 0 }],
    );
    expect(f).toMatchObject({ totalNetPence: 1000, totalVatPence: 0, grossPence: 1000, reconciles: true });
  });
});
