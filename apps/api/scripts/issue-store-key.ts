/**
 * Local-dev convenience: wipe + re-issue an api-key for the Storefront Demo
 * company. Prints the raw key on stdout. Used while developing apps/store.
 *
 *   DATABASE_URL=... npx tsx scripts/issue-store-key.ts
 */
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { apiKeys } from '../src/db/schema/index.js';
import { ApiKeyService } from '../src/modules/admin/api-keys.service.js';

const COMPANY = '11111111-1111-4111-8111-111111111111';

async function main() {
  const db = getDb();
  await db.delete(apiKeys).where(eq(apiKeys.companyId, COMPANY));
  const svc = new ApiKeyService();
  const ok = await svc.issue(COMPANY, {
    name: 'store-local-dev',
    scopes: ['storefront:read', 'storefront:write'],
  });
  // eslint-disable-next-line no-console
  console.log(`KEY=${ok.rawKey}`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('issue-store-key failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
