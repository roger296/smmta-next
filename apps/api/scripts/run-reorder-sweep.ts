/**
 * Daily reorder sweep (spec §A7). Evaluates every low-stock (product, site) and
 * raises replenishment proposals for any that have none open. In production this
 * is fired by a systemd timer (P24); run it manually with:
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/run-reorder-sweep.ts
 */
import 'dotenv/config';
import { closeDatabase } from '../src/config/database.js';
import { runReorderSweep } from '../src/modules/reorder/reorder.sweep.js';

const isCliEntry = process.argv[1]?.endsWith('run-reorder-sweep.ts') ?? false;

if (isCliEntry) {
  runReorderSweep()
    .then((r) => console.log(`[reorder-sweep] OK — evaluated ${r.evaluated}, created ${r.created}`))
    .catch((err) => {
      console.error('[reorder-sweep] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}
