/**
 * One stock-take as a spreadsheet — the Download button on the count screen.
 *
 * Asked for on 30 Sept 2026: once a count is approved there was nowhere to see
 * what had been counted. The sheet is for checking a count (before approving
 * it, or after), so it carries what a checker needs on one row — book, counted,
 * variance, who and when — sorted the way the count screen is: by section,
 * Uncategorised last, then by name.
 */
import { toCsv } from '../../shared/utils/csv.js';
import type { StockTake, StockTakeLineWithProduct } from './stock-take.service.js';
import { londonStamp } from './stock-take-dates.js';

const UNCATEGORISED = 'Uncategorised';

const num = (v: string | null): number | '' => (v == null ? '' : Number(v));

/** `toCsv` wants a plain record; the line interface has no index signature. */
type Row = StockTakeLineWithProduct & Record<string, unknown>;

export function stockTakeCsv(lines: readonly StockTakeLineWithProduct[]): string {
  const sorted = [...lines].sort((a, b) => {
    const sa = a.itemCategoryName ?? UNCATEGORISED;
    const sb = b.itemCategoryName ?? UNCATEGORISED;
    if (sa !== sb) {
      if (sa === UNCATEGORISED) return 1;
      if (sb === UNCATEGORISED) return -1;
      return sa.localeCompare(sb);
    }
    return (a.productName ?? '').localeCompare(b.productName ?? '');
  });
  return toCsv<Row>(
    [
      { header: 'Section', value: (l) => l.itemCategoryName ?? UNCATEGORISED },
      { header: 'Stock code', value: (l) => l.stockCode },
      { header: 'Product', value: (l) => l.productName },
      { header: 'Unit', value: (l) => l.stockUom },
      { header: 'Book', value: (l) => num(l.bookQty) },
      { header: 'Counted', value: (l) => num(l.countedQty) },
      // Only once counted: an uncounted line has no variance, not a variance
      // of minus the book figure.
      { header: 'Variance', value: (l) => (l.countedQty == null ? '' : num(l.variance)) },
      { header: 'Counted by', value: (l) => l.countedByName },
      { header: 'Counted at', value: (l) => londonStamp(l.countedAt) },
    ],
    sorted as Row[],
  );
}

export function stockTakeCsvFilename(take: StockTake, siteName: string | null): string {
  const venue = (siteName ?? 'venue').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const day = new Date(take.createdAt).toISOString().slice(0, 10);
  return `stock-take-${venue}-${day}.csv`;
}

/**
 * Every COUNTED line of several takes, one CSV — "Download all" on the
 * results page for a venue and date range. Uncounted lines are left out: a
 * full sheet is ~640 lines and most of a partial count is blank, so including
 * them buries the answer. Each row names its venue and sheet, because a venue
 * that split its count across sheets has the same product on more than one.
 */
export function stockTakesRangeCsv(
  takes: ReadonlyArray<{ take: StockTake; siteName: string; lines: readonly StockTakeLineWithProduct[] }>,
): string {
  type RangeRow = Record<string, unknown> & {
    take: StockTake;
    siteName: string;
    line: StockTakeLineWithProduct;
  };
  const rows: RangeRow[] = [];
  for (const t of takes) {
    for (const line of t.lines) if (line.countedQty != null) rows.push({ take: t.take, siteName: t.siteName, line });
  }
  return toCsv<RangeRow>(
    [
      { header: 'Venue', value: (r) => r.siteName },
      { header: 'Sheet opened', value: (r) => londonStamp(r.take.createdAt) },
      { header: 'Status', value: (r) => r.take.status },
      { header: 'Section', value: (r) => r.line.itemCategoryName ?? UNCATEGORISED },
      { header: 'Stock code', value: (r) => r.line.stockCode },
      { header: 'Product', value: (r) => r.line.productName },
      { header: 'Unit', value: (r) => r.line.stockUom },
      { header: 'Book', value: (r) => num(r.line.bookQty) },
      { header: 'Counted', value: (r) => num(r.line.countedQty) },
      { header: 'Variance', value: (r) => num(r.line.variance) },
      { header: 'Counted by', value: (r) => r.line.countedByName },
      { header: 'Counted at', value: (r) => londonStamp(r.line.countedAt) },
      { header: 'Take id', value: (r) => r.take.id },
    ],
    rows,
  );
}
