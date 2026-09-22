/**
 * Reading the product export layout. Pure: no database. The rows are made
 * up; only the headings match the export.
 */
import { describe, expect, it } from 'vitest';
import { parseProductsCsv, toCm, validEan } from './product-csv-import.js';

const HEADER =
  'Stock Code,Product Name,Fully Qualified Name,ProductGroupId,Manufacturer,Product Description,Net Weight,Shipping Weight,' +
  'Dimension - H,Dimension - W,Dimension - D,Measurement Unit,Next Cost Method,EAN Code,Main Selling Price,Price Setting Method,' +
  'Margin,Rounding Method,Expected Next Cost,MinimumStock Level,Preferred Stock Level,Manufactures Part Number,Item Status,' +
  'Release Date(dd/mm/yyyy),Date Of Discontinuation(dd/mm/yyyy),Text Tag 1,Text Tag 2,Text Tag 3,Unit of Measure,Color,' +
  'Enter Serial Numbers at Book in (yes/No),Require Batch Number (Yes/No),Product Type,Stock Available Quantity,' +
  'Stock Allocated Quantity,Purchase Order Quantity,Customer Back Order Quantity,Seller Integration SKU,Integration SKU 2,' +
  'Integration SKU 3,Integration SKU 4,Integration SKU 5,Integration SKU 6,Integration SKU 7,Integration SKU 8,' +
  'Integration SKU 9,Integration SKU 10,HS Code,Image 1,Image 2,Image 3,Image 4,Image 5,';

const row = (o: Partial<Record<string, string>> = {}) => {
  const d: Record<string, string> = {
    code: 'RING-S', range: 'Plain Band Ring', full: 'Plain Band Ring Small', group: '4001', maker: 'Example Makers',
    desc: '"A plain band, in three sizes"', weight: '0.05', ship: '0.07', h: '6.00', w: '10.00', dd: '1.00', unit: 'cm',
    costMethod: 'Manual', ean: '5012345678900', price: '24.9500', priceMethod: 'Manual  (Fixed)  selling  price', margin: '0',
    rounding: 'Do  Not  Round', cost: '4.9900', minStock: '3', prefStock: '10', mpn: 'RING-S', status: 'Available', rel: '', disc: '',
    tag1: 'Rings-Plain', tag2: 'Rings > All Rings', tag3: '', uom: 'Each', colour: 'Small', serial: 'No', batch: 'No', type: 'Physical',
    avail: '0', alloc: '0', po: '0', bo: '0', sku1: 'RING-S', sku2: 'AMZ-RING-S', sku3: '', sku4: '', sku5: '', sku6: '', sku7: '',
    sku8: '', sku9: '', sku10: '', hs: '', img1: 'https://img.example.com/ring-1.jpg', img2: 'https://img.example.com/ring-2.jpg',
    img3: '', img4: '', img5: '',
  };
  const r = { ...d, ...o };
  return [
    r.code, r.range, r.full, r.group, r.maker, r.desc, r.weight, r.ship, r.h, r.w, r.dd, r.unit, r.costMethod, r.ean, r.price,
    r.priceMethod, r.margin, r.rounding, r.cost, r.minStock, r.prefStock, r.mpn, r.status, r.rel, r.disc, r.tag1, r.tag2, r.tag3,
    r.uom, r.colour, r.serial, r.batch, r.type, r.avail, r.alloc, r.po, r.bo, r.sku1, r.sku2, r.sku3, r.sku4, r.sku5, r.sku6,
    r.sku7, r.sku8, r.sku9, r.sku10, r.hs, r.img1, r.img2, r.img3, r.img4, r.img5, '',
  ].join(',');
};

describe('parseProductsCsv — export layout', () => {
  it('reads every field this system keeps', () => {
    const { rows, skipped } = parseProductsCsv([HEADER, row()].join('\r\n'));
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      line: 2,
      stockCode: 'RING-S',
      name: 'Plain Band Ring Small',
      rangeName: 'Plain Band Ring',
      groupKey: 'id:4001',
      oldGroupId: 4001,
      manufacturer: 'Example Makers',
      manufacturerPartNumber: 'RING-S',
      description: 'A plain band, in three sizes',
      weightKg: 0.05,
      heightCm: 6,
      widthCm: 10,
      lengthCm: 1,
      ean: '5012345678900',
      sellingPrice: 24.95,
      expectedNextCost: 4.99,
      productType: 'PHYSICAL',
      requireSerialNumber: false,
      requireBatchNumber: false,
      colour: 'Small',
      hsCode: null,
      sellerSkus: ['RING-S', 'AMZ-RING-S'],
      imageUrls: ['https://img.example.com/ring-1.jpg', 'https://img.example.com/ring-2.jpg'],
      tags: ['Rings-Plain', 'Rings > All Rings'],
    });
  });

  it('drops an EAN that is not a barcode, reads Yes/No flags and Service, and converts mm to cm', () => {
    const { rows } = parseProductsCsv([HEADER, row({ ean: 'RING-S', serial: 'Yes', batch: 'yes', type: 'Service', unit: 'mm', h: '60' })].join('\n'));
    expect(rows[0]!.ean).toBeNull();
    expect(rows[0]!.requireSerialNumber).toBe(true);
    expect(rows[0]!.requireBatchNumber).toBe(true);
    expect(rows[0]!.productType).toBe('SERVICE');
    expect(rows[0]!.heightCm).toBe(6);
  });

  it('skips rows without a stock code or name, and a stock code seen twice, naming the line', () => {
    const csv = [HEADER, row({ code: '' }), row({ code: 'X', range: '', full: '' }), row({ code: 'Y' }), row({ code: 'Y' })].join('\n');
    const { rows, skipped } = parseProductsCsv(csv);
    expect(rows.map((r) => r.stockCode)).toEqual(['Y']);
    expect(skipped).toEqual([
      { line: 2, stockCode: null, reason: 'No stock code' },
      { line: 3, stockCode: 'X', reason: 'No product name' },
      { line: 5, stockCode: 'Y', reason: 'Stock code repeated in the file' },
    ]);
  });

  it('ignores a manufacturer that merely repeats the stock code', () => {
    const { rows } = parseProductsCsv([HEADER, row({ maker: 'RING-S' }), row({ code: 'RING-M', maker: 'ring-m' })].join('\n'));
    expect(rows.map((r) => r.manufacturer)).toEqual([null, null]);
  });

  it('groups by range name when there is no group id', () => {
    const { rows } = parseProductsCsv([HEADER, row({ group: '' }), row({ code: 'RING-M', group: '', full: 'Plain Band Ring Medium' })].join('\n'));
    expect(rows.map((r) => r.groupKey)).toEqual(['name:plain band ring', 'name:plain band ring']);
  });
});

describe('parseProductsCsv — a plain sheet', () => {
  it('accepts SKU, Name, Price and Cost headings', () => {
    const { rows, recognisedHeadings } = parseProductsCsv('SKU,Name,Price,Cost,Barcode,Weight (kg)\nW-1,Widget,9.99,4.50,5012345678900,0.2\n');
    expect(recognisedHeadings).toEqual(['sku', 'name', 'price', 'cost', 'barcode', 'weightkg']);
    expect(rows[0]).toMatchObject({ stockCode: 'W-1', name: 'Widget', rangeName: 'Widget', sellingPrice: 9.99, expectedNextCost: 4.5, ean: '5012345678900', weightKg: 0.2 });
  });
});

describe('helpers', () => {
  it('validEan keeps only 8, 12, 13 or 14 digit codes', () => {
    expect(validEan('5012345678900')).toBe('5012345678900');
    expect(validEan('12345678')).toBe('12345678');
    expect(validEan('ABC-1')).toBeNull();
    expect(validEan('123')).toBeNull();
  });
  it('toCm converts mm and inches and leaves cm', () => {
    expect(toCm(25, 'mm')).toBe(2.5);
    expect(toCm(2, 'in')).toBe(5.08);
    expect(toCm(7, 'cm')).toBe(7);
    expect(toCm(7, null)).toBe(7);
  });
});
