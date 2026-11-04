/**
 * One email contact for every address the store already holds (customers,
 * storefront users, newsletter subscribers, back-in-stock requesters), with
 * marketing consent only where there is evidence of it. Idempotent.
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/email/backfill-contacts.ts
 */
import { closeDatabase } from '../../src/config/database.js';
import { BackfillService } from '../../src/modules/email/services/backfill.service.js';

async function main() {
  const counts = await new BackfillService().run();
  console.log(JSON.stringify(counts, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
