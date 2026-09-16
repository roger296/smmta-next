/**
 * Is BumbleBee session polling actually wired up?
 *
 *   npx tsx apps/api/scripts/check-bumblebee.ts [YYYY-MM-DD]
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Every way of getting this wrong produces the SAME symptom: zero sessions.
 * Not configured, wrong base URL, expired key, a site name BumbleBee has never
 * heard of, a quiet Tuesday — the venue screen shows an empty picker for all of
 * them, and `run-bumblebee-session-poll.ts` prints "0 session(s)" for all of
 * them too.
 *
 * That is exactly the shape of the defects this system keeps producing: a
 * screen that says nothing, about a thing that silently did nothing. So before
 * anyone concludes "the feed is broken" or, worse, "there were no sessions",
 * this says which of those it actually is.
 *
 * Read-only. It fetches; it writes nothing, to BumbleBee or to Auto-Stock.
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { sites } from '../src/db/schema/index.js';
import { getEnv } from '../src/config/env.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { BumbleBeeSessionClient } from '../src/modules/consumption/bumblebee-sessions.js';

export type SiteVerdict =
  | { site: string; ok: true; sessions: number; covers: number }
  | { site: string; ok: false; reason: string };

export interface BumbleBeeCheck {
  configured: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  date: string;
  sites: SiteVerdict[];
}

/** Never print a key, or a URL that might carry one in a query string. */
export function redactUrl(raw: string): string {
  if (!raw) return '(not set)';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return '(not a valid URL)';
  }
}

export async function checkBumbleBee(
  date = new Date().toISOString().slice(0, 10),
): Promise<BumbleBeeCheck> {
  const env = getEnv();
  const companyId = getSingletonCompanyId();
  const check: BumbleBeeCheck = {
    configured: !!env.BUMBLEBEE_API_BASE_URL,
    baseUrl: redactUrl(env.BUMBLEBEE_API_BASE_URL),
    hasApiKey: !!env.BUMBLEBEE_API_KEY,
    date,
    sites: [],
  };
  if (!check.configured) return check;

  const client = new BumbleBeeSessionClient();
  const activeSites = await getDb().query.sites.findMany({
    where: and(eq(sites.companyId, companyId), eq(sites.isActive, true)),
  });

  for (const site of activeSites) {
    try {
      const day = await client.listSessionsForDay({
        siteCanonicalName: site.canonicalName,
        date,
        companyId,
      });
      check.sites.push({
        site: site.canonicalName,
        ok: true,
        sessions: day.length,
        covers: day.reduce((t, s) => t + s.covers, 0),
      });
    } catch (err) {
      check.sites.push({
        site: site.canonicalName,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return check;
}

const isCliEntry = process.argv[1]?.endsWith('check-bumblebee.ts') ?? false;

if (isCliEntry) {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  checkBumbleBee(date)
    .then((c) => {
      console.log('[check-bumblebee] BumbleBee session feed');
      console.log(`  base URL : ${c.baseUrl}`);
      console.log(`  API key  : ${c.hasApiKey ? 'set' : 'NOT SET'}`);
      console.log(`  date     : ${c.date}`);
      console.log('');

      if (!c.configured) {
        console.log('  ✗ NOT CONNECTED — BUMBLEBEE_API_BASE_URL is not set.');
        console.log('');
        console.log('  The venue End of Bake screen cannot offer the day’s sessions, so');
        console.log('  bakers type the session id by hand. That still works; it is just');
        console.log('  the thing this feed would remove.');
        console.log('');
        console.log('  Set BUMBLEBEE_API_BASE_URL and BUMBLEBEE_API_KEY on the stock-api');
        console.log('  app in Coolify, redeploy, and run this again.');
        return;
      }

      const failed = c.sites.filter((s): s is Extract<SiteVerdict, { ok: false }> => !s.ok);
      const ok = c.sites.filter((s): s is Extract<SiteVerdict, { ok: true }> => s.ok);

      for (const s of c.sites) {
        if (s.ok) {
          console.log(
            `  ${s.sessions > 0 ? '✓' : '·'} ${s.site.padEnd(14)} ${s.sessions} session(s), ${s.covers} guest(s)`,
          );
        } else {
          console.log(`  ✗ ${s.site.padEnd(14)} ${s.reason}`);
        }
      }
      console.log('');

      if (failed.length > 0) {
        // Name the likeliest cause rather than leaving an HTTP code on screen.
        const unauthorised = failed.some((s) => /401|403|API_KEY/i.test(s.reason));
        console.log(`  ✗ ${failed.length} site(s) could not be read.`);
        if (unauthorised) {
          console.log('    A 401/403 means the key is wrong, expired, or lacks scope.');
          console.log('    Mint a fresh one in BumbleBee at /admin/api-keys.');
        } else {
          console.log('    Check the base URL is reachable from the stock-api container.');
        }
        process.exitCode = 1;
        return;
      }

      const withSessions = ok.filter((s) => s.sessions > 0);
      if (withSessions.length === 0) {
        console.log('  ⚠ Connected, authenticated — and every site returned nothing.');
        console.log('');
        console.log(`  That is either a genuinely quiet ${c.date}, or a site-name`);
        console.log('  mismatch. BumbleBee filters on its own site names, and Auto-Stock');
        console.log('  sends `sites.canonical_name`. If those differ by so much as a');
        console.log('  space, every query returns zero rows and NOTHING errors.');
        console.log('');
        console.log('  Try a date you know had bakes. If it is still empty, compare the');
        console.log('  names above against BumbleBee’s own site list.');
        return;
      }

      console.log(`  ✓ WIRED UP — ${withSessions.length} of ${ok.length} site(s) returned sessions.`);
      console.log('    The End of Bake screen will offer these instead of asking for an id.');
    })
    .catch((err) => {
      console.error('[check-bumblebee] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}
