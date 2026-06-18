/**
 * BumbleBee session poll (P16, spec §A6). Fired by `smmta-bumblebee-poll.timer`;
 * run manually with:
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/run-bumblebee-session-poll.ts [YYYY-MM-DD]
 *
 * Pulls the day's sessions for each active site from BumbleBee so the
 * "awaiting a consumption record" view + MCP tool stay warm. Best-effort and
 * guarded: with no BumbleBee base URL configured it polls nothing (returns 0)
 * — the live endpoint is a go-live step. Defaults to today.
 */
import 'dotenv/config';
import { eq, and } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { sites } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { BumbleBeeSessionClient } from '../src/modules/consumption/bumblebee-sessions.js';

export async function runBumblebeeSessionPoll(date = new Date().toISOString().slice(0, 10)): Promise<{ sites: number; sessions: number }> {
  const companyId = getSingletonCompanyId();
  const client = new BumbleBeeSessionClient();
  const activeSites = await getDb().query.sites.findMany({
    where: and(eq(sites.companyId, companyId), eq(sites.isActive, true)),
  });
  let sessions = 0;
  for (const site of activeSites) {
    const day = await client.listSessionsForDay({ siteCanonicalName: site.canonicalName, date, companyId });
    sessions += day.length;
  }
  return { sites: activeSites.length, sessions };
}

const isCliEntry = process.argv[1]?.endsWith('run-bumblebee-session-poll.ts') ?? false;

if (isCliEntry) {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  runBumblebeeSessionPoll(date)
    .then((r) => console.log(`[bumblebee-poll] OK ${date} — ${r.sites} site(s), ${r.sessions} session(s)`))
    .catch((err) => {
      console.error('[bumblebee-poll] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}
