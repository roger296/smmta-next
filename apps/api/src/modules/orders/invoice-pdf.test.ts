/**
 * Invoice PDF rendering: A4, and long invoices flow onto further pages.
 */
import { describe, expect, it } from 'vitest';
import { A4, gbp, longDate, renderInvoicePdf, type InvoicePdfInput } from './invoice-pdf.js';

const invoice = (lineCount: number): InvoicePdfInput => ({
  invoiceNumber: 'INV-000042',
  invoiceDate: '2026-09-11',
  dueDate: null,
  orderNumber: 'STORE-EBE1CE630088',
  customerReference: null,
  billTo: ['Roger Test', 'Close Cottage', 'Mow Lane', 'Stoke-on-Trent', 'ST7 3PL'],
  deliverTo: ['Roger Test', 'Close Cottage', 'Stoke-on-Trent', 'ST7 3PL'],
  lines: Array.from({ length: lineCount }, (_, i) => ({
    description: `Landau PLA Basic 1.75mm 1kg — Colour ${i + 1}`,
    sku: `V3-PLA-BAS-${i + 1}`,
    quantity: 2,
    unitNetPence: 1024,
    vatRate: 20,
    netPence: 2047,
  })),
  delivery: { netPence: 413, vatRate: 20 },
  totals: { netPence: 2460, vatPence: 491, grossPence: 2951 },
  paymentNote: 'Paid online on 10 September 2026. Thank you for your order.',
});

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('renderInvoicePdf', () => {
  it('produces an A4 PDF', async () => {
    const pdf = await renderInvoicePdf(invoice(1), { compress: false });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(A4).toEqual([595.28, 841.89]);
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.28 841\.89\]/);
  });

  it('fits a short invoice on one page and flows a long one onto more', async () => {
    expect(pageCount(await renderInvoicePdf(invoice(2), { compress: false }))).toBe(1);
    expect(pageCount(await renderInvoicePdf(invoice(60), { compress: false }))).toBeGreaterThan(1);
  });
});

describe('formatting', () => {
  it('writes dates in full and money in pounds', () => {
    expect(longDate('2026-09-11')).toBe('11 September 2026');
    expect(gbp(2951)).toBe('£29.51');
    expect(gbp(123456)).toBe('£1,234.56');
  });
});
