/**
 * The committed corrections file has to parse, and it has to keep naming stock
 * codes that exist. It is hand-edited - one row per human decision - and a
 * stray quote in a `why` sentence would take the whole file with it, silently
 * dropping corrections the repair depends on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCorrectionsCsv } from './fix-supplier-mappings.js';

const FILE = join(import.meta.dirname, '..', 'data', 'invoice-skus', 'mapping-corrections.csv');

describe('mapping-corrections.csv', () => {
  const rows = readCorrectionsCsv(readFileSync(FILE, 'utf8'));

  it('parses every row, quoted commentary and all', () => {
    // A row that fails to parse is dropped by the filter rather than raising,
    // so assert the count rather than trusting a clean run.
    const dataLines = readFileSync(FILE, 'utf8').trim().split('\n').length - 1;
    expect(rows).toHaveLength(dataLines);
  });

  it('carries the decisions made so far', () => {
    expect(rows.map((r) => [r.supplier, r.supplierSku, r.stockCode])).toEqual([
      ['Brakes', '10417', 'CARR'],
      ['Brakes', '350101', 'BAKE-ICNG-SUGR'],
    ]);
  });

  it('gives every correction a reason, because the point is that it travels', () => {
    for (const r of rows) expect(r.why.length).toBeGreaterThan(20);
  });

  it('never names one supplier code twice', () => {
    const keys = rows.map((r) => `${r.supplier.toLowerCase()}/${r.supplierSku.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
