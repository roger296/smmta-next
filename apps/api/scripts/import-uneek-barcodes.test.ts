/**
 * Unit tests for the pure helpers in `import-uneek-barcodes.ts`. No DB: the
 * script's main() is only invoked when the file is run directly.
 */
import { describe, expect, it } from 'vitest';
import {
  normaliseCsvRow,
  normaliseEan,
  parseWeightKg,
  readIdentifiers,
} from './import-uneek-barcodes.js';

describe('normaliseEan', () => {
  it('accepts barcodes at GTIN lengths', () => {
    expect(normaliseEan('5056449221259')).toBe('5056449221259'); // GTIN-13
    expect(normaliseEan('12345678')).toBe('12345678'); // GTIN-8
    expect(normaliseEan(' 5056449221259 ')).toBe('5056449221259');
    expect(normaliseEan('5056-4492-21259')).toBe('5056449221259');
  });

  it('refuses anything that is not a barcode', () => {
    // Supplier files really do say this in the barcode column.
    expect(normaliseEan('Not available')).toBeNull();
    expect(normaliseEan('')).toBeNull();
    expect(normaliseEan(undefined)).toBeNull();
    expect(normaliseEan('505644922125')).toBe('505644922125'); // 12 is a GTIN length
    expect(normaliseEan('50564492212')).toBeNull(); // 11 digits is not
    expect(normaliseEan('5056449221259X')).toBeNull();
  });
});

describe('parseWeightKg', () => {
  it('reads kilogrammes to 3dp, ignoring nonsense', () => {
    expect(parseWeightKg('0.31')).toBe('0.310');
    expect(parseWeightKg(' 1 ')).toBe('1.000');
    expect(parseWeightKg('0')).toBeNull();
    expect(parseWeightKg('')).toBeNull();
    expect(parseWeightKg('n/a')).toBeNull();
  });
});

describe('normaliseCsvRow', () => {
  const row = {
    'Short Code': 'GR11BGXS',
    'EAN (Bar Code)': '5056449221259',
    Company: 'Uneek Clothing',
    'Gross Weight': '0.31',
    'Commodity Code': '6105909000',
  };

  it('maps a row onto the columns we store', () => {
    expect(normaliseCsvRow(row)).toEqual({
      stockCode: 'GR11BGXS',
      ean: '5056449221259',
      brand: 'Uneek Clothing',
      weightKg: '0.310',
      hsCode: '6105909000',
    });
  });

  it('keeps a row with no barcode, so brand and weight still land', () => {
    expect(normaliseCsvRow({ ...row, 'EAN (Bar Code)': '' })).toMatchObject({
      stockCode: 'GR11BGXS',
      ean: null,
      brand: 'Uneek Clothing',
    });
  });

  it('skips a row with no short code, since nothing can be matched', () => {
    expect(normaliseCsvRow({ ...row, 'Short Code': '  ' })).toBeNull();
  });
});

describe('readIdentifiers', () => {
  const csv = [
    'Short Code,EAN (Bar Code),Company,Gross Weight,Commodity Code',
    'GR11BGXS,5056449221259,Uneek Clothing,0.31,6105909000',
    'GR11BGSM,5056449221235,Uneek Clothing,0.31,6105909000',
    ',9999999999999,Uneek Clothing,0.31,6105909000',
  ].join('\n');

  it('keys rows by stock code and drops the ones with none', () => {
    const map = readIdentifiers(csv, null);
    expect([...map.keys()]).toEqual(['GR11BGXS', 'GR11BGSM']);
    expect(map.get('GR11BGSM')?.ean).toBe('5056449221235');
  });

  it('honours the limit', () => {
    expect(readIdentifiers(csv, 1).size).toBe(1);
  });
});
