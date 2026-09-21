/**
 * The CSV order parser, both layouts. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  detectCsvLayout,
  normaliseHeading,
  parseCsvRecords,
  parseLegacyDate,
  parseOrdersCsv,
} from './csv-import.service.js';

const LEGACY_HEADER = [
  'Order Id', 'Order Date(dd/mm/yyyy)', 'Customer Name', 'Email Address', 'Customer Contact',
  'Courier Name', 'Warehouse Name', 'Tax Scheme', 'Tax to be (Exclusive/Inclusive)', 'Express',
  'Delivery Charge', 'Delivery Tax Rate', 'Product Code', 'Quantity', 'Price', 'Tax Rate',
  'Customization Codes',
  'Contact Name For Delivery Address', 'Address Line 1 For Delivery Address',
  'Address Line 2 For Delivery Address', 'City For Delivery Address', 'Region For Delivery Address',
  'Post Code For Delivery Address', 'Country For Delivery Address',
  'Contact Name For Invoice Address', 'Address Line 1 For Invoice Address',
  'Address Line 2 For Invoice Address', 'City For Invoice Address', 'Region For Invoice Address',
  'Post Code For Invoice Address', 'Country For Invoice Address',
].join(',');

const legacyRow = (overrides: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    orderId: '1001', date: '21/09/2026', name: 'Jane Example', email: 'jane@example.invalid',
    contact: '07700 900123', courier: 'Royal Mail', warehouse: 'Main', scheme: 'UK VAT',
    taxToBe: 'Inclusive', express: 'No', delivery: '3.95', deliveryTax: '20',
    sku: 'ABC-1', qty: '2', price: '9.99', tax: '20', custom: '',
    dName: 'Jane Example', dLine1: '1 High Street', dLine2: '', dCity: 'Newtown', dRegion: 'Shire',
    dPost: 'AB1 2CD', dCountry: 'United Kingdom',
    iName: 'Accounts', iLine1: '2 Office Row', iLine2: 'Floor 3', iCity: 'Oldtown', iRegion: 'Shire',
    iPost: 'ZY9 8XW', iCountry: 'United Kingdom',
  };
  const r = { ...base, ...overrides };
  return [
    r.orderId, r.date, r.name, r.email, r.contact, r.courier, r.warehouse, r.scheme, r.taxToBe,
    r.express, r.delivery, r.deliveryTax, r.sku, r.qty, r.price, r.tax, r.custom,
    r.dName, r.dLine1, r.dLine2, r.dCity, r.dRegion, r.dPost, r.dCountry,
    r.iName, r.iLine1, r.iLine2, r.iCity, r.iRegion, r.iPost, r.iCountry,
  ].join(',');
};

describe('normaliseHeading / detectCsvLayout', () => {
  it('reduces a heading to letters and digits', () => {
    expect(normaliseHeading('Order Date(dd/mm/yyyy)')).toBe('orderdateddmmyyyy');
    expect(normaliseHeading('Address Line 1 For Delivery Address')).toBe('addressline1fordeliveryaddress');
  });

  it('recognises the legacy layout by Order Id + Product Code', () => {
    expect(detectCsvLayout(['Order Id', 'Product Code', 'Quantity'])).toBe('legacy');
    expect(detectCsvLayout(['OrderNumber', 'SKU', 'Qty'])).toBe('native');
    expect(detectCsvLayout(['order_id', 'PRODUCT CODE'])).toBe('legacy');
  });
});

describe('parseCsvRecords', () => {
  it('handles CRLF, quoted commas, doubled quotes and a BOM', () => {
    const text = '﻿a,b\r\n"Smith, Jane","She said ""hi"""\r\nx,y\r\n';
    expect(parseCsvRecords(text)).toEqual([
      ['a', 'b'],
      ['Smith, Jane', 'She said "hi"'],
      ['x', 'y'],
    ]);
  });

  it('keeps a line break inside a quoted field', () => {
    expect(parseCsvRecords('a\n"line one\nline two"')).toEqual([['a'], ['line one\nline two']]);
  });
});

describe('parseLegacyDate', () => {
  it('turns dd/mm/yyyy into yyyy-mm-dd and accepts ISO as it is', () => {
    expect(parseLegacyDate('21/09/2026')).toBe('2026-09-21');
    expect(parseLegacyDate('1/2/2026')).toBe('2026-02-01');
    expect(parseLegacyDate('2026-09-21')).toBe('2026-09-21');
    expect(parseLegacyDate('yesterday')).toBeUndefined();
  });
});

describe('parseOrdersCsv — native layout', () => {
  it('groups rows by OrderNumber and reads the columns it always did', () => {
    const csv = [
      'OrderNumber,CustomerName,CustomerEmail,DeliveryName,DeliveryLine1,DeliveryCity,DeliveryPostCode,DeliveryCountry,OrderDate,Currency,SKU,ProductName,Qty,UnitPrice,TaxRate,DeliveryCharge,PaymentMethod',
      'N1,Ann,ann@example.invalid,Ann,3 Lane,Town,T1 1TT,GB,2026-09-20,GBP,SKU-A,Widget,1,5.00,20,2.50,Card',
      'N1,Ann,ann@example.invalid,Ann,3 Lane,Town,T1 1TT,GB,2026-09-20,GBP,SKU-B,Gadget,3,1.25,20,2.50,Card',
    ].join('\n');
    const orders = parseOrdersCsv(csv);
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.thirdPartyOrderId).toBe('N1');
    expect(o.sourceChannel).toBe('CSV');
    expect(o.customer).toEqual({ name: 'Ann', email: 'ann@example.invalid' });
    expect(o.deliveryAddress.line1).toBe('3 Lane');
    expect(o.orderDate).toBe('2026-09-20');
    expect(o.deliveryCharge).toBe(2.5);
    expect(o.paymentMethod).toBe('Card');
    expect(o.lines.map((l) => [l.sku, l.quantity, l.pricePerUnit, l.taxRate])).toEqual([
      ['SKU-A', 1, 5, 20],
      ['SKU-B', 3, 1.25, 20],
    ]);
  });
});

describe('parseOrdersCsv — legacy layout', () => {
  it('reads the order, its two addresses and its lines', () => {
    const csv = [LEGACY_HEADER, legacyRow(), legacyRow({ sku: 'ABC-2', qty: '1', price: '4.50', custom: 'ENGRAVE:JE' })].join('\r\n');
    const orders = parseOrdersCsv(csv);
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.thirdPartyOrderId).toBe('1001');
    expect(o.customerOrderNumber).toBe('1001');
    expect(o.sourceChannel).toBe('CSV');
    expect(o.orderDate).toBe('2026-09-21');
    expect(o.customer).toEqual({ name: 'Jane Example', email: 'jane@example.invalid', phone: '07700 900123' });
    expect(o.courierName).toBe('Royal Mail');
    expect(o.warehouseName).toBe('Main');
    expect(o.taxInclusive).toBe(true);
    expect(o.deliveryCharge).toBe(3.95);
    expect(o.deliveryAddress).toEqual({
      contactName: 'Jane Example', line1: '1 High Street', line2: undefined, city: 'Newtown',
      region: 'Shire', postCode: 'AB1 2CD', country: 'United Kingdom', phone: '07700 900123',
    });
    expect(o.invoiceAddress).toEqual({
      contactName: 'Accounts', line1: '2 Office Row', line2: 'Floor 3', city: 'Oldtown',
      region: 'Shire', postCode: 'ZY9 8XW', country: 'United Kingdom',
    });
    expect(o.lines).toEqual([
      { sku: 'ABC-1', name: 'ABC-1', quantity: 2, pricePerUnit: 9.99, taxRate: 20 },
      { sku: 'ABC-2', name: 'ABC-2', quantity: 1, pricePerUnit: 4.5, taxRate: 20 },
    ]);
    expect(o.rawData).toEqual({
      layout: 'legacy', taxScheme: 'UK VAT', express: 'No', deliveryTaxRate: '20',
      customizationCodes: ['', 'ENGRAVE:JE'],
    });
  });

  it('separates orders by Order Id and treats exclusive tax and a blank invoice address as absent', () => {
    const csv = [
      LEGACY_HEADER,
      legacyRow({ orderId: 'A', taxToBe: 'Exclusive', iLine1: '', iName: '', iCity: '', iPost: '', iCountry: '', iRegion: '', iLine2: '' }),
      legacyRow({ orderId: 'B', sku: 'XYZ' }),
    ].join('\n');
    const orders = parseOrdersCsv(csv);
    expect(orders.map((o) => o.thirdPartyOrderId)).toEqual(['A', 'B']);
    expect(orders[0]!.taxInclusive).toBe(false);
    expect(orders[0]!.invoiceAddress).toBeUndefined();
    expect(orders[1]!.lines[0]!.sku).toBe('XYZ');
  });

  it('returns nothing for a header-only file', () => {
    expect(parseOrdersCsv(LEGACY_HEADER + '\n')).toEqual([]);
  });
});
