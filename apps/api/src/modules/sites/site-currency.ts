/**
 * Site currency lookup (P20, spec §A5/§7).
 *
 * Multi-site means multi-currency: a UK site is GBP/metric, Dallas is
 * USD/imperial. Stock movements, GL journals and reorder proposals must carry
 * the *site's* currency, not a hardcoded GBP. This is the single place that
 * resolves it (defaults GBP for a site with none / an unknown id).
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { sites } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export async function getSiteCurrency(siteId: string, companyId = getSingletonCompanyId()): Promise<string> {
  const row = await getDb().query.sites.findFirst({
    where: and(eq(sites.id, siteId), eq(sites.companyId, companyId)),
    columns: { currencyCode: true },
  });
  return row?.currencyCode ?? 'GBP';
}
