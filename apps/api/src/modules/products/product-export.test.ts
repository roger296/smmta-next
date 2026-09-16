import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { products } from '../../db/schema/index.js';
import {
  PRODUCT_EXPORT_COLUMNS,
  buildProductExportCsv,
  productExportFilename,
  type ProductExportRow,
} from './product-export.js';

/**
 * Columns deliberately left out, each with the reason. Anything NOT listed here
 * must appear in the export — see the coverage test below.
 */
const DELIBERATELY_OMITTED: Record<string, string> = {
  companyId: 'single-tenant: the same constant on every row, so it is noise',
  deletedAt: 'the export is live products only, so it is always null',
};

function row(overrides: Partial<ProductExportRow> = {}): ProductExportRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Plain Flour',
    manufacturerName: null,
    supplierName: null,
    categoryName: null,
    groupName: null,
    defaultWarehouseName: null,
    imageUrls: [],
    ...overrides,
  };
}

describe('product export coverage', () => {
  it('exports every column the products table actually has', () => {
    const tableColumns = Object.keys(getTableColumns(products));
    const exported = new Set(PRODUCT_EXPORT_COLUMNS.map((c) => c.source));
    const missing = tableColumns.filter(
      (key) => !exported.has(key) && !(key in DELIBERATELY_OMITTED),
    );
    expect(missing, `add these to PRODUCT_EXPORT_COLUMNS: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not export a column that no longer exists on the table', () => {
    const tableColumns = new Set(Object.keys(getTableColumns(products)));
    // The joined name columns are computed, not stored, so they are expected.
    const computed = new Set([
      'manufacturerName',
      'supplierName',
      'categoryName',
      'groupName',
      'defaultWarehouseName',
      'imageUrls',
    ]);
    const stale = PRODUCT_EXPORT_COLUMNS.map((c) => c.source).filter(
      (key) => !tableColumns.has(key) && !computed.has(key),
    );
    expect(stale, `these columns are gone from the table: ${stale.join(', ')}`).toEqual([]);
  });

  it('has no duplicate headers', () => {
    const headers = PRODUCT_EXPORT_COLUMNS.map((c) => c.header);
    expect(new Set(headers).size).toBe(headers.length);
  });
});

describe('buildProductExportCsv', () => {
  it('writes a header row naming the fields, then one row per product', () => {
    const csv = buildProductExportCsv([row({ name: 'Plain Flour' }), row({ name: 'Caster Sugar' })]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Name');
    expect(lines[0]).toContain('Expected next cost');
    expect(lines[1]).toContain('Plain Flour');
    expect(lines[2]).toContain('Caster Sugar');
  });

  it('writes the header even when the catalogue is empty', () => {
    expect(buildProductExportCsv([]).trimEnd().split('\r\n')).toHaveLength(1);
  });

  it('resolves a foreign key to a readable name AND keeps the id', () => {
    const csv = buildProductExportCsv([
      row({ supplierName: 'Brakes', supplierId: 'abc-123' }),
    ]);
    expect(csv).toContain('Brakes');
    expect(csv).toContain('abc-123');
  });

  it('flattens image lists to URLs, not JSON', () => {
    const csv = buildProductExportCsv([
      row({
        heroImageUrl: 'https://cdn/hero.jpg',
        galleryImageUrls: ['https://cdn/a.jpg', 'https://cdn/b.jpg'],
        imageUrls: ['https://cdn/c.jpg'],
      }),
    ]);
    expect(csv).toContain('https://cdn/hero.jpg');
    expect(csv).toContain('https://cdn/a.jpg | https://cdn/b.jpg');
    expect(csv).toContain('https://cdn/c.jpg');
    expect(csv).not.toContain('[{');
  });

  it('leaves an unset image column empty rather than writing "null"', () => {
    const csv = buildProductExportCsv([row({ heroImageUrl: null, galleryImageUrls: null })]);
    expect(csv).not.toMatch(/null/);
  });

  it('keeps a product name that would otherwise be a live formula inert', () => {
    const csv = buildProductExportCsv([row({ name: '=HYPERLINK("http://evil")' })]);
    expect(csv).toContain(`'=HYPERLINK`);
  });

  it('keeps a name containing a comma in one cell', () => {
    const csv = buildProductExportCsv([row({ name: 'Sugar, icing' })]);
    expect(csv).toContain('"Sugar, icing"');
  });
});

describe('productExportFilename', () => {
  it('is dated, so successive exports do not overwrite each other', () => {
    expect(productExportFilename(new Date('2026-09-16T10:03:00Z'))).toBe('products-2026-09-16.csv');
  });
});
