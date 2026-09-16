import { describe, expect, it } from 'vitest';
import {
  HEADER_TO_FIELD,
  ProductImportFormatError,
  parseProductCsv,
} from './product-import.js';
import { PRODUCT_EXPORT_COLUMNS, buildProductExportCsv } from './product-export.js';

const HEAD = 'Name,Stock code,Stock UoM,Expected next cost,Item category,Stock check instruction';

function csv(...rows: string[]): string {
  return [HEAD, ...rows].join('\r\n');
}

describe('the import format is the export format', () => {
  it('knows every header the export writes', () => {
    const missing = PRODUCT_EXPORT_COLUMNS.filter(
      (c) => !HEADER_TO_FIELD.has(c.header.toLowerCase()),
    );
    expect(missing.map((c) => c.header)).toEqual([]);
  });

  it('accepts a file produced by the export unchanged', () => {
    const exported = buildProductExportCsv([
      {
        id: 'p1',
        name: 'Plain Flour',
        stockCode: 'FLOUR-01',
        stockUom: 'g',
        manufacturerName: null,
        supplierName: null,
        categoryName: null,
        groupName: null,
        defaultWarehouseName: null,
        itemCategoryName: null,
        imageUrls: [],
      },
    ]);
    const parsed = parseProductCsv(exported);
    expect(parsed.errors).toEqual([]);
    expect(parsed.unknownColumns).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.stockCode).toBe('FLOUR-01');
  });

  it('ignores the read-only columns rather than trying to write them', () => {
    const parsed = parseProductCsv(
      'Product ID,Name,Stock code,Supplier,Created at\r\np1,Flour,FLOUR-01,Brakes,2026-01-01\r\n',
    );
    expect(parsed.ignoredColumns).toEqual(
      expect.arrayContaining(['Product ID', 'Supplier', 'Created at']),
    );
    expect(parsed.rows[0]?.values).not.toHaveProperty('id');
    expect(parsed.rows[0]?.values).not.toHaveProperty('supplierName');
  });

  it('reports a column it has never heard of instead of ignoring it quietly', () => {
    const parsed = parseProductCsv('Name,Stock code,Fave Colour\r\nFlour,FLOUR-01,blue\r\n');
    expect(parsed.unknownColumns).toEqual(['Fave Colour']);
  });
});

describe('refusing a file that cannot be applied', () => {
  it('refuses a file with no Stock code column, naming why', () => {
    expect(() => parseProductCsv('Name,Stock UoM\r\nFlour,g\r\n')).toThrow(
      /no "Stock code" column/i,
    );
  });

  it('refuses a header-only file', () => {
    expect(() => parseProductCsv(`${HEAD}\r\n`)).toThrow(ProductImportFormatError);
  });

  it('refuses a file whose quoting is broken', () => {
    expect(() =>
      parseProductCsv('Name,Stock code\r\n"unterminated,FLOUR-01\r\nmore,F2\r\n'),
    ).toThrow(ProductImportFormatError);
  });
});

describe('row-level validation', () => {
  it('rejects a row with no stock code, naming the row', () => {
    const parsed = parseProductCsv(csv('Flour,,g,1,,'));
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]).toMatchObject({ row: 2 });
    expect(parsed.errors[0]?.message).toMatch(/Stock code/);
  });

  it('rejects two rows sharing a stock code, naming the other row', () => {
    const parsed = parseProductCsv(csv('Flour,FLOUR-01,g,1,,', 'Flour again,FLOUR-01,g,1,,'));
    expect(parsed.errors[0]?.message).toMatch(/also on row 2/);
  });

  it('matches stock codes case-insensitively when spotting duplicates', () => {
    const parsed = parseProductCsv(csv('Flour,FLOUR-01,g,1,,', 'Flour,flour-01,g,1,,'));
    expect(parsed.errors).toHaveLength(1);
  });

  it('rejects a blank Name - a product cannot have one', () => {
    const parsed = parseProductCsv(csv(',FLOUR-01,g,1,,'));
    expect(parsed.errors[0]?.message).toMatch(/cannot have an empty name/i);
  });

  it('rejects a cost that is not a number, quoting what was there', () => {
    const parsed = parseProductCsv(csv('Flour,FLOUR-01,g,about a quid,,'));
    expect(parsed.errors[0]?.message).toMatch(/"about a quid", which is not a number/);
  });

  it('rejects a negative cost', () => {
    const parsed = parseProductCsv(csv('Flour,FLOUR-01,g,-5,,'));
    expect(parsed.errors[0]?.message).toMatch(/cannot be negative/);
  });

  it('rejects an unknown product type, listing the valid ones', () => {
    const parsed = parseProductCsv('Name,Stock code,Product type\r\nFlour,F1,GASEOUS\r\n');
    expect(parsed.errors[0]?.message).toMatch(/PHYSICAL, SERVICE/);
  });

  // The spreadsheet formats the column and nobody asked it to.
  it('accepts a cost a spreadsheet has formatted as currency', () => {
    const parsed = parseProductCsv(csv('Flour,FLOUR-01,g,"£1,234.50",,'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.values.expectedNextCost).toBe(1234.5);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['1', true],
    ['false', false],
    ['no', false],
    ['0', false],
  ])('reads "%s" as a boolean', (raw, expected) => {
    const parsed = parseProductCsv(`Name,Stock code,Is stocked\r\nFlour,F1,${raw}\r\n`);
    expect(parsed.rows[0]?.values.isStocked).toBe(expected);
  });

  it('rejects a boolean it cannot read rather than guessing', () => {
    const parsed = parseProductCsv('Name,Stock code,Is stocked\r\nFlour,F1,maybe\r\n');
    expect(parsed.errors[0]?.message).toMatch(/must be true or false/);
  });
});

// The rule that makes "clear this field" expressible at all.
describe('missing column vs empty cell', () => {
  it('leaves a field alone when its column is absent', () => {
    const parsed = parseProductCsv('Name,Stock code\r\nFlour,FLOUR-01\r\n');
    expect(parsed.rows[0]?.values).not.toHaveProperty('packDescription');
  });

  it('clears a field when its cell is empty', () => {
    const parsed = parseProductCsv('Name,Stock code,Pack description\r\nFlour,FLOUR-01,\r\n');
    expect(parsed.rows[0]?.values.packDescription).toBeNull();
  });

  it('distinguishes an absent category column from a blanked one', () => {
    const absent = parseProductCsv('Name,Stock code\r\nFlour,FLOUR-01\r\n');
    expect(absent.rows[0]?.itemCategoryName).toBeNull();

    const blanked = parseProductCsv('Name,Stock code,Item category\r\nFlour,FLOUR-01,\r\n');
    expect(blanked.rows[0]?.itemCategoryName).toBe('');

    const named = parseProductCsv('Name,Stock code,Item category\r\nFlour,FLOUR-01,Dry Stock\r\n');
    expect(named.rows[0]?.itemCategoryName).toBe('Dry Stock');
  });
});

describe('the new fields', () => {
  it('reads the stock check instruction', () => {
    const parsed = parseProductCsv(csv('Flour,FLOUR-01,g,1,,"Weigh, do not count"'));
    expect(parsed.rows[0]?.values.stockCheckInstruction).toBe('Weigh, do not count');
  });

  it('reads the item category by name', () => {
    const parsed = parseProductCsv(csv('Flour,FLOUR-01,g,1,Dry Stock,'));
    expect(parsed.rows[0]?.itemCategoryName).toBe('Dry Stock');
  });
});

describe('list columns round-trip through the pipe separator', () => {
  it('splits gallery URLs back into a list', () => {
    const parsed = parseProductCsv(
      'Name,Stock code,Gallery image URLs\r\nFlour,F1,https://a/1.jpg | https://a/2.jpg\r\n',
    );
    expect(parsed.rows[0]?.values.galleryImageUrls).toEqual([
      'https://a/1.jpg',
      'https://a/2.jpg',
    ]);
  });
});
