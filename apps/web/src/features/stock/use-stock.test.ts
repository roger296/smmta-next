import { describe, expect, it } from 'vitest';
import { buildStockReportCsv } from './use-stock';
import type { StockReportRow } from '@/lib/api-types';

const rows: StockReportRow[] = [
  {
    warehouseId: 'wh-1',
    warehouseName: 'Main',
    productId: 'p-1',
    productName: 'Widget, Large',
    stockCode: 'WID-L',
    quantity: 10,
    totalValue: '100.00',
  },
  {
    warehouseId: 'wh-1',
    warehouseName: 'Main',
    productId: 'p-2',
    productName: 'Gadget "Pro"',
    stockCode: null,
    quantity: 5,
    totalValue: '250.00',
  },
];

describe('buildStockReportCsv', () => {
  it('includes header row + data rows', () => {
    const csv = buildStockReportCsv(rows);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Warehouse,Product,Stock code,Quantity,Total value');
  });

  it('quotes values containing commas', () => {
    const csv = buildStockReportCsv(rows);
    expect(csv).toContain('"Widget, Large"');
  });

  it('escapes double quotes by doubling them', () => {
    const csv = buildStockReportCsv(rows);
    expect(csv).toContain('"Gadget ""Pro"""');
  });

  it('handles null stockCode as empty', () => {
    const csv = buildStockReportCsv(rows);
    const row2 = csv.split('\n')[2]!;
    expect(row2).toContain('Main,"Gadget ""Pro""",,5,250.00');
  });

  it('returns header only for empty input', () => {
    expect(buildStockReportCsv([])).toBe('Warehouse,Product,Stock code,Quantity,Total value');
  });
});
