/**
 * Every stock-take in a date range, across all venues. READ-ONLY.
 *
 *   npx tsx apps/api/scripts/report-stock-takes.ts --from 2026-09-20 --to 2026-10-04
 *   npx tsx apps/api/scripts/report-stock-takes.ts --from 2026-09-20 --to 2026-10-04 --lines
 *
 * Asked for on 4 Oct 2026: "the results of all the stock takes from the end of
 * September and the beginning of October". The count screen shows one venue's
 * recent counts and downloads one count at a time; this is the whole picture
 * in one go, for someone in the stock-api terminal.
 *
 * Default output is one summary line per take: venue, scope, status, when it
 * was opened and approved, lines counted of lines on the sheet, who counted,
 * how many counted lines differ from book, and the net value of those
 * differences at each product's expected next cost (the figure approval posts).
 *
 * `--lines` adds every COUNTED line as CSV (uncounted lines are left out —
 * a full sheet is ~640 lines and most of a partial count is blank).
 *
 * A take is in range if it was opened OR approved inside it. Dates are the
 * venue's (Europe/London) calendar days, inclusive.
 */
import 'dotenv/config';
import { inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, sites } from '../src/db/schema/index.js';
import { StockTakeService } from '../src/modules/stock-take/stock-take.service.js';
import { csvCell } from '../src/shared/utils/csv.js';

const LONDON = 'Europe/London';

/** YYYY-MM-DD of a moment, on the London calendar. */
export function londonDay(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LONDON, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(d),
  );
}

/** "30/09/2026 15:47", London time. */
export function londonStamp(d: Date | string | null | undefined): string {
  if (!d) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: LONDON,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(d))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

export function inRange(
  take: { createdAt: Date | string; approvedAt: Date | string | null },
  from: string,
  to: string,
): boolean {
  const days = [londonDay(take.createdAt), take.approvedAt ? londonDay(take.approvedAt) : null];
  return days.some((d) => d !== null && d >= from && d <= to);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const from = arg('--from');
  const to = arg('--to') ?? londonDay(new Date());
  const withLines = process.argv.includes('--lines');
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('give --from YYYY-MM-DD (and optionally --to YYYY-MM-DD, default today)');
  }

  const db = getDb();
  const service = new StockTakeService();
  const siteRows = await db.select({ id: sites.id, name: sites.name }).from(sites);
  const siteName = new Map(siteRows.map((s) => [s.id, s.name]));

  const takes = (await service.list()).filter((t) => inRange(t, from, to));
  takes.sort(
    (a, b) =>
      (siteName.get(a.siteId) ?? '').localeCompare(siteName.get(b.siteId) ?? '') ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  console.log(`[report-stock-takes] ${from} to ${to} (London days) — ${takes.length} stock-take(s). READ-ONLY.\n`);
  if (takes.length === 0) return;

  const summary = [
    'Venue,Scope,Status,Opened,Opened by,Approved,Counted,Lines,Counted by,Lines with variance,Net variance £,Take id',
  ];
  const lineRows = [
    'Venue,Take opened,Status,Section,Stock code,Product,Unit,Book,Counted,Variance,Variance £,Counted by,Counted at',
  ];

  for (const t of takes) {
    // A plain read: no top-up, so the report never changes a take.
    const lines = await service.linesWithProduct(t.id);
    const counted = lines.filter((l) => l.countedQty != null);
    const ids = [...new Set(counted.map((l) => l.productId))];
    const costs = ids.length
      ? new Map(
          (
            await db
              .select({ id: products.id, cost: products.expectedNextCost })
              .from(products)
              .where(inArray(products.id, ids))
          ).map((p) => [p.id, Number(p.cost ?? 0)]),
        )
      : new Map<string, number>();

    let varianceLines = 0;
    let net = 0;
    for (const l of counted) {
      const v = Number(l.variance ?? 0);
      const value = Math.round(v * (costs.get(l.productId) ?? 0) * 100) / 100;
      if (v !== 0) {
        varianceLines++;
        net += value;
      }
      if (withLines) {
        lineRows.push(
          [
            siteName.get(t.siteId) ?? t.siteId,
            londonStamp(t.createdAt),
            t.status,
            l.itemCategoryName ?? 'Uncategorised',
            l.stockCode,
            l.productName,
            l.stockUom,
            Number(l.bookQty),
            Number(l.countedQty),
            v,
            value,
            l.countedByName,
            londonStamp(l.countedAt),
          ]
            .map(csvCell)
            .join(','),
        );
      }
    }

    summary.push(
      [
        siteName.get(t.siteId) ?? t.siteId,
        t.scope,
        t.status,
        londonStamp(t.createdAt),
        t.openedByName,
        londonStamp(t.approvedAt),
        counted.length,
        lines.length,
        t.counters.join(' + '),
        varianceLines,
        Math.round(net * 100) / 100,
        t.id,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  console.log('── SUMMARY ──');
  console.log(summary.join('\n'));
  if (withLines) {
    console.log('\n── COUNTED LINES ──');
    console.log(lineRows.join('\n'));
  } else {
    console.log('\n(Add --lines to list every counted line as well.)');
  }
}

const isCliEntry = process.argv[1]?.endsWith('report-stock-takes.ts') ?? false;
if (isCliEntry) {
  main()
    .catch((err) => {
      console.error('[report-stock-takes] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
