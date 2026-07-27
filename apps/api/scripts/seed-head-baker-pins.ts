/**
 * Create one head-baker device PIN per site.
 *
 *   npx tsx apps/api/scripts/seed-head-baker-pins.ts            # generate PINs
 *   npx tsx apps/api/scripts/seed-head-baker-pins.ts --dry-run  # show, write nothing
 *   HEAD_BAKER_PIN_MANCHESTER=481920 npx tsx … seed-head-baker-pins.ts
 *
 * Shared site iPads: one PIN per site, labelled "<Site> Head Baker", scoped to
 * that site with the `head_baker` role. Tapping it in yields a 12h JWT carrying
 * the site, so anything filed from the device is attributed to that site.
 *
 * Idempotent: a site that already has an active head-baker PIN is left alone,
 * so re-running never mints a second PIN or invalidates one in use. Rotating a
 * PIN means deactivating the old row, not re-running this.
 *
 * ⚠️ PINs MUST BE DISTINCT ACROSS SITES. `POST /auth/pin-login` accepts an
 * OPTIONAL siteId; without one it scans every active PIN and takes the FIRST
 * whose hash verifies, in whatever order Postgres returns rows. Two sites
 * sharing a PIN would therefore log a baker into an arbitrary one of them and
 * file their counts against the wrong site — silently. Generated PINs are
 * checked for collisions here; supplied ones are rejected if they clash.
 */
import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { devicePins, sites } from '../src/db/schema/index.js';
import { hashPassword } from '../src/shared/auth/password.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

/** Placeholder labels — a site-level identity, not a named person. Replace the
 *  label when the actual head baker is known; the PIN itself can stay. */
export function labelFor(siteName: string): string {
  return `${siteName} Head Baker`;
}

/** Env override so PINs can be chosen rather than generated, e.g.
 *  HEAD_BAKER_PIN_LONDON_EAST for "London East". */
export function envKeyFor(siteName: string): string {
  return `HEAD_BAKER_PIN_${siteName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/** 6 digits, no leading zero — leading zeros get eaten by spreadsheets and by
 *  numeric keypads that strip them, and a PIN that fails to round-trip through
 *  a handover note is worse than one digit less of entropy. */
function generatePin(taken: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const pin = String(randomInt(100_000, 1_000_000));
    if (!taken.has(pin)) return pin;
  }
  throw new Error('could not generate a distinct PIN');
}

export interface PinResult {
  site: string;
  label: string;
  status: 'created' | 'exists' | 'would-create';
  /** Only set for rows this run created — an existing PIN's value is a hash. */
  pin?: string;
}

export async function seedHeadBakerPins(
  opts: { dryRun?: boolean } = {},
): Promise<PinResult[]> {
  const companyId = getSingletonCompanyId();
  const db = getDb();

  const siteRows = await db.query.sites.findMany({ where: eq(sites.companyId, companyId) });
  if (siteRows.length === 0) {
    throw new Error('no sites found — run seed-sites.ts first');
  }

  // Every active PIN in the company, so generated values can't collide with an
  // existing one. Hashes are one-way, so a supplied PIN can only be checked
  // against others supplied in this same run.
  const activePins = await db.query.devicePins.findMany({
    where: and(eq(devicePins.companyId, companyId), eq(devicePins.isActive, true)),
  });
  const chosen = new Set<string>();
  const results: PinResult[] = [];

  for (const site of [...siteRows].sort((a, b) => a.name.localeCompare(b.name))) {
    const label = labelFor(site.name);
    const already = activePins.find((p) => p.siteId === site.id && p.roles.includes('head_baker'));
    if (already) {
      results.push({ site: site.name, label: already.label, status: 'exists' });
      continue;
    }

    const supplied = process.env[envKeyFor(site.name)];
    if (supplied && chosen.has(supplied)) {
      throw new Error(
        `${envKeyFor(site.name)} duplicates another site's PIN — they must be distinct, ` +
          'or pin-login will attribute counts to the wrong site',
      );
    }
    const pin = supplied ?? generatePin(chosen);
    chosen.add(pin);

    if (opts.dryRun) {
      results.push({ site: site.name, label, status: 'would-create', pin });
      continue;
    }

    await db.insert(devicePins).values({
      companyId,
      siteId: site.id,
      label,
      pinHash: await hashPassword(pin),
      roles: ['head_baker'],
    });
    results.push({ site: site.name, label, status: 'created', pin });
  }

  return results;
}

const isCliEntry = process.argv[1]?.endsWith('seed-head-baker-pins.ts') ?? false;

if (isCliEntry) {
  const dryRun = process.argv.includes('--dry-run');
  seedHeadBakerPins({ dryRun })
    .then((results) => {
      const fresh = results.filter((r) => r.pin);
      console.log(`[seed-head-baker-pins] ${dryRun ? 'DRY RUN — nothing written' : 'OK'}`);
      console.log('');
      for (const r of results) {
        const mark = r.status === 'exists' ? '·' : '+';
        console.log(
          `  ${mark} ${r.label.padEnd(28)} ${r.status === 'exists' ? '(already set — unchanged)' : (r.pin ?? '')}`,
        );
      }
      if (fresh.length > 0) {
        console.log('');
        console.log('  ^ Copy these now — they are scrypt-hashed and cannot be read back.');
        console.log('    To rotate one later, deactivate its row and re-run.');
      }
    })
    .catch((err) => {
      console.error('[seed-head-baker-pins] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
