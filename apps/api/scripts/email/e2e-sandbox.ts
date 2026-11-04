/**
 * Runs the whole email system end to end in sandbox mode against DATABASE_URL
 * (point it at a FRESH, migrated database — it adds fixture rows):
 *
 *   createdb email_e2e && DATABASE_URL=…/email_e2e npm run db:migrate -w @smmta/api
 *   DATABASE_URL=…/email_e2e npx tsx apps/api/scripts/email/e2e-sandbox.ts
 *
 * Nothing is sent anywhere: SendGrid is replaced by a recorder.
 */
import { closeDatabase } from '../../src/config/database.js';
import { runEmailE2E } from '../../src/modules/email/e2e-flow.js';

runEmailE2E()
  .then((r) => console.log(JSON.stringify({ ...r, report: { sent: r.report.sent, delivered: r.report.delivered, clicked: r.report.clicked } }, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
