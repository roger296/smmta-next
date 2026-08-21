/**
 * Two risks here, and neither shows up as an error at import time.
 *
 * The first is a name that does not match the one already in the database. The
 * importer matches suppliers by name, so "makro" against a stored "Makro" makes
 * a SECOND Makro — two rows, one spend history, and a reorder proposal that
 * picks whichever it found first. The extract's canonical map exists to stop
 * that, and the check below holds it to the catalogue's spelling.
 *
 * The second is a duplicate slug. That column is uniquely indexed, so a clash
 * is at least loud — but only for the row that loses, halfway through a run
 * that has already written the rows before it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSupplierCsv } from './import-invoice-suppliers.js';
import { splitCsvLine } from './import-supplier-catalogue.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'invoice-suppliers');
const read = (f: string) => readSupplierCsv(readFileSync(join(DATA_DIR, f), 'utf8'));

describe('readSupplierCsv', () => {
  it('reads columns by header name, not position', () => {
    // Column order is the extractor's business, not the importer's. Reading by
    // position would silently swap spend and invoice count if it ever changed.
    const rows = readSupplierCsv(
      'spend_gbp,name,invoice_count,slug,type,aliases,in_catalogue\n' +
        '168869.16,Brakes,421,brakes,Stock,,yes\n',
    );
    expect(rows).toEqual([
      { name: 'Brakes', slug: 'brakes', type: 'Stock', spendGbp: 168869.16, invoiceCount: 421 },
    ]);
  });

  it('keeps a quoted comma inside the name', () => {
    const rows = readSupplierCsv(
      'name,slug,type,aliases,invoice_count,spend_gbp,in_catalogue\n' +
        '"Young & Co, Ltd",young-co,Stock,,13,22680.00,no\n',
    );
    expect(rows[0]!.name).toBe('Young & Co, Ltd');
  });

  it('treats a blank spend as zero rather than NaN', () => {
    // NaN would sort to the bottom of the not-orderable list and read as if the
    // supplier were the least urgent, when in fact nothing is known about it.
    const rows = readSupplierCsv(
      'name,slug,type,aliases,invoice_count,spend_gbp,in_catalogue\nKing Makers,king-makers,Stock,,,,no\n',
    );
    expect(rows[0]!.spendGbp).toBe(0);
  });
});

describe('the committed extract', () => {
  const keep = read('suppliers.csv');
  const review = read('suppliers-review.csv');

  it('names every supplier once', () => {
    const names = [...keep, ...review].map((r) => r.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every supplier a distinct slug', () => {
    const slugs = [...keep, ...review].map((r) => r.slug);
    expect(slugs.filter((s) => !s)).toEqual([]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('spells shared suppliers exactly as the catalogue import does', () => {
    // Both imports write into the same table and both match on name. A
    // divergence here forks the supplier: "Cater for you" alongside the
    // "Cater 4 You" that already has the SKUs mapped to it.
    const catalogue = readFileSync(
      join(import.meta.dirname, '..', 'data', 'supplier-catalogue', 'suppliers.csv'),
      'utf8',
    )
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((l) => splitCsvLine(l)[0]!);
    const mine = new Set(keep.map((r) => r.name));
    const missing = catalogue.filter((n) => !mine.has(n));
    expect(missing).toEqual([]);
  });

  it('holds back only the long tail, never a supplier of real size', () => {
    for (const r of review) {
      expect(r.spendGbp).toBeLessThan(100);
      expect(r.invoiceCount).toBeLessThan(3);
    }
  });
});
