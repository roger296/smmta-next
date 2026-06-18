/**
 * Daily consumption COGS / wastage Xero sweep (P17, spec §A8). Fired by
 * `smmta-consumption-sweep.timer` once a day; run it manually with:
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/run-consumption-sweep.ts [YYYY-MM-DD]
 *
 * Aggregates the day's consumption into one balanced COGS + one wastage journal
 * per site and posts to Xero (dry-run by default — XERO_DRY_RUN). Idempotent on
 * the per-(site, day) key, so a re-run is a no-op. Defaults to today.
 */
import 'dotenv/config';
import { closeDatabase } from '../src/config/database.js';
import { ConsumptionSweepService } from '../src/modules/consumption/consumption-sweep.service.js';

const isCliEntry = process.argv[1]?.endsWith('run-consumption-sweep.ts') ?? false;

if (isCliEntry) {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  new ConsumptionSweepService()
    .runDaily({ date })
    .then((r) =>
      console.log(
        `[consumption-sweep] OK ${r.date} — ${r.sites} site(s), COGS ${r.totalCogs} (${r.cogsPosted}), wastage ${r.totalWastage} (${r.wastagePosted})`,
      ),
    )
    .catch((err) => {
      console.error('[consumption-sweep] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}
