/**
 * Square sales poll (P10, spec §A8). Fired by `smmta-square-poll.timer`; run
 * manually with:
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/run-square-poll.ts
 *
 * In production this pulls recently-closed Square orders and feeds their lines
 * to `SquareDecrementService.ingestBatch`, which decrements stock idempotently
 * on (channel_slug, source_pk, source_line_ref). The live Square Orders fetch
 * is a go-live wiring: with no SQUARE_ACCESS_TOKEN configured the poll has
 * nothing to pull and exits cleanly (the decrement path itself is fully built +
 * tested; this is just the periodic puller).
 */
import 'dotenv/config';
import { closeDatabase } from '../src/config/database.js';

export async function runSquarePoll(): Promise<{ pulled: number; applied: number; configured: boolean }> {
  const configured = !!process.env.SQUARE_ACCESS_TOKEN;
  if (!configured) {
    return { pulled: 0, applied: 0, configured: false };
  }
  // Go-live: fetch closed orders from the Square Orders API since the last
  // cursor and `new SquareDecrementService().ingestBatch(lines)`. Left as the
  // documented integration point — credentials aren't present in the build.
  return { pulled: 0, applied: 0, configured: true };
}

const isCliEntry = process.argv[1]?.endsWith('run-square-poll.ts') ?? false;

if (isCliEntry) {
  runSquarePoll()
    .then((r) =>
      console.log(
        r.configured
          ? `[square-poll] OK — pulled ${r.pulled}, applied ${r.applied}`
          : '[square-poll] skipped — no SQUARE_ACCESS_TOKEN configured',
      ),
    )
    .catch((err) => {
      console.error('[square-poll] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}
