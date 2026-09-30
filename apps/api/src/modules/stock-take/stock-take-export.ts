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

const UNCATEGORISED = 'Uncategorised';

/** Wall-clock time at the venue. An ISO timestamp in UTC would read an hour
 *  out for half the year to anyone checking "did Sam count this at 10?". */
function londonTime(d: Date | string | null): string {
  if (!d) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(d))
      .map((p) => [p.type, p.value]),
  );
  // "30/09/2026 15:47" — assembled, because en-GB puts a comma after the date
  // and a comma forces the cell into quotes for no benefit.
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

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
      { header: 'Counted at', value: (l) => londonTime(l.countedAt) },
    ],
    sorted as Row[],
  );
}

export function stockTakeCsvFilename(take: StockTake, siteName: string | null): string {
  const venue = (siteName ?? 'venue').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const day = new Date(take.createdAt).toISOString().slice(0, 10);
  return `stock-take-${venue}-${day}.csv`;
}
