/**
 * The CSV splitter is the quiet risk here. Supplier and product names in this
 * data are full of commas ("Sauce Pots with Lids (4oz)", "Broom Handles - Red
 * & Blue"), and a naive split shifts every later column by one — so a price
 * lands in the pack-size field and nothing about the row looks wrong.
 */
import { describe, expect, it } from 'vitest';
import { splitCsvLine } from './import-supplier-catalogue.js';

describe('splitCsvLine', () => {
  it('keeps a quoted comma inside its field', () => {
    expect(splitCsvLine('SKU,"Red, Green & White Strands",Culpitt')).toEqual([
      'SKU',
      'Red, Green & White Strands',
      'Culpitt',
    ]);
  });

  it('handles an escaped quote inside a quoted field', () => {
    expect(splitCsvLine('A,"10"" Round Cake Cards",B')).toEqual([
      'A',
      '10" Round Cake Cards',
      'B',
    ]);
  });

  it('preserves empty trailing fields, which carry the placeholder flags', () => {
    // price_is_placeholder and sku_is_placeholder are blank when false; losing
    // a trailing empty would shift the flags onto the wrong column.
    expect(splitCsvLine('a,b,,')).toEqual(['a', 'b', '', '']);
  });

  it('leaves an unquoted row alone', () => {
    expect(splitCsvLine('BAKE-YEAS-DRY,Brakes,114951,1.20')).toEqual([
      'BAKE-YEAS-DRY',
      'Brakes',
      '114951',
      '1.20',
    ]);
  });
});
