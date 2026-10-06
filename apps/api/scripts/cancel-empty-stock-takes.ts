/**
 * Cancel the OPEN stock-takes that have nothing counted on them.
 *
 *   npx tsx apps/api/scripts/cancel-empty-stock-takes.ts            # dry run
 *   npx tsx apps/api/scripts/cancel-empty-stock-takes.ts --apply
 *   … --min-age-hours 2    (default 12)
 *
 * Between 20 Sept and 4 Oct 2026 the venues opened 49 counts and approved
 * none; 37 had nothing counted on them — people starting a new count instead
 * of joining the one running. They clutter the join list, and now that a venue
 * may only have one open count (CountInProgressError), an empty sheet would
 * also stand in the way of a real one.
 *
 * Only sheets with NOT ONE counted line are touched, and only once they are
 * older than --min-age-hours, so a count somebody opened a minute ago and has
 * not saved into yet is left alone. Cancelling keeps the sheet (status
 * CANCELLED); nothing is deleted and no stock level changes. A sheet with
 * counts on it is never cancelled here — that is a manager's decision, made
 * from the Stock-takes page.
 */
import 'dotenv/config';
import { closeDatabase, getDb } from '../src/config/database.js';
import { sites } from '../src/db/schema/index.js';
import { StockTakeService } from '../src/modules/stock-take/stock-take.service.js';
import { londonStamp } from '../src/modules/stock-take/stock-take-dates.js';

export interface EmptyTakeResult {
  id: string;
  site: string;
  openedAt: Date;
  openedBy: string | null;
  status: 'cancelled' | 'would-cancel';
}

export async function cancelEmptyStockTakes(opts: { apply?: boolean; minAgeHours?: number; now?: Date } = {}) {
  const service = new StockTakeService();
  const minAge = (opts.minAgeHours ?? 12) * 3600_000;
  const now = (opts.now ?? new Date()).getTime();
  const siteRows = await getDb().select({ id: sites.id, name: sites.name }).from(sites);
  const siteName = new Map(siteRows.map((s) => [s.id, s.name]));

  const open = await service.list({ status: 'OPEN' });
  const empty = open.filter((t) => t.countedCount === 0 && now - new Date(t.createdAt).getTime() >= minAge);
  const results: EmptyTakeResult[] = [];
  for (const t of empty) {
    if (opts.apply) await service.cancel(t.id);
    results.push({
      id: t.id,
      site: siteName.get(t.siteId) ?? t.siteId,
      openedAt: new Date(t.createdAt),
      openedBy: t.openedByName,
      status: opts.apply ? 'cancelled' : 'would-cancel',
    });
  }
  const keptWithCounts = open.filter((t) => t.countedCount > 0).length;
  return { results, keptWithCounts, openBefore: open.length };
}

const isCliEntry = process.argv[1]?.endsWith('cancel-empty-stock-takes.ts') ?? false;
if (isCliEntry) {
  const apply = process.argv.includes('--apply');
  const i = process.argv.indexOf('--min-age-hours');
  const minAgeHours = i >= 0 ? Number(process.argv[i + 1]) : 12;
  cancelEmptyStockTakes({ apply, minAgeHours })
    .then(({ results, keptWithCounts, openBefore }) => {
      console.log(`[cancel-empty-stock-takes] ${apply ? 'APPLIED' : 'DRY RUN — nothing changed (pass --apply)'}\n`);
      console.log(`  open counts:            ${openBefore}`);
      console.log(`  ${apply ? 'cancelled' : 'would cancel'} (empty):  ${results.length}`);
      console.log(`  left open (have counts): ${keptWithCounts}\n`);
      for (const r of results.sort((a, b) => a.site.localeCompare(b.site) || +a.openedAt - +b.openedAt)) {
        console.log(`  ${r.site.padEnd(14)} ${londonStamp(r.openedAt)}  ${r.openedBy ?? '(no name)'}`);
      }
    })
    .catch((err) => {
      console.error('[cancel-empty-stock-takes] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
