/**
 * Seed the canonical UK sites (spec §A5).
 *
 * Inserts the five Big Bakes UK sites with slugs aligned to BumbleBee's
 * canonical site names. Idempotent — re-running upserts by slug, leaving
 * existing rows (and any per-site reorder levels / stock) untouched. The
 * USD/imperial Dallas site is added later through the admin Sites page
 * (P20), not here.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx apps/api/scripts/seed-sites.ts
 */
import 'dotenv/config';
import { closeDatabase } from '../src/config/database.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { SiteService } from '../src/modules/sites/site.service.js';

interface SeedSite {
  slug: string;
  name: string;
  canonicalName: string;
}

/** The five canonical UK sites. `canonicalName` is the BumbleBee display
 *  string used for cross-system joins. */
export const UK_SITES: SeedSite[] = [
  { slug: 'birmingham', name: 'Birmingham', canonicalName: 'Birmingham' },
  { slug: 'liverpool', name: 'Liverpool', canonicalName: 'Liverpool' },
  { slug: 'london-east', name: 'London East', canonicalName: 'London East' },
  { slug: 'london-south', name: 'London South', canonicalName: 'London South' },
  { slug: 'manchester', name: 'Manchester', canonicalName: 'Manchester' },
];

export async function seedSites(): Promise<Array<{ slug: string; status: 'created' | 'exists' }>> {
  const service = new SiteService();
  const companyId = getSingletonCompanyId();
  const summary: Array<{ slug: string; status: 'created' | 'exists' }> = [];
  for (const site of UK_SITES) {
    const existing = await service.getBySlug(site.slug, companyId);
    if (existing) {
      summary.push({ slug: site.slug, status: 'exists' });
      continue;
    }
    await service.create(
      {
        slug: site.slug,
        name: site.name,
        canonicalName: site.canonicalName,
        currencyCode: 'GBP',
        uomSystem: 'METRIC',
        timezone: 'Europe/London',
      },
      companyId,
    );
    summary.push({ slug: site.slug, status: 'created' });
  }
  return summary;
}

const isCliEntry = process.argv[1]?.endsWith('seed-sites.ts') ?? false;

if (isCliEntry) {
  seedSites()
    .then((summary) => {
      const created = summary.filter((r) => r.status === 'created').length;
      console.log('[seed-sites] OK');
      console.log(`  created: ${created}, already present: ${summary.length - created}`);
      for (const row of summary) {
        console.log(`  ${row.status === 'created' ? '+' : '·'} ${row.slug}`);
      }
    })
    .catch((err) => {
      console.error('[seed-sites] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabase();
    });
}
