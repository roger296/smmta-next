/**
 * CLI entry point for the supplier-poll worker. Invoked by
 * `infra/systemd/smmta-supplier-poll.service`, which is itself fired
 * by `smmta-supplier-poll.timer` every 3 hours.
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/run-supplier-poll.ts
 *
 * Optional flags:
 *   --supplier-id <uuid>   only poll this supplier (skip cadence checks)
 *   --ignore-cadence       poll every supplier regardless of last-polled time
 */
import 'dotenv/config';
import { closeDatabase } from '../src/config/database.js';
import { runSupplierPoll } from '../src/workers/supplier-poll.worker.js';

function parseArgs(argv: string[]) {
  let onlySupplierId: string | undefined;
  let ignoreCadence = false;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--supplier-id' && argv[i + 1]) {
      onlySupplierId = argv[++i];
    } else if (flag === '--ignore-cadence') {
      ignoreCadence = true;
    } else if (flag === '--help' || flag === '-h') {
      console.error(
        'Usage: tsx run-supplier-poll.ts [--supplier-id <uuid>] [--ignore-cadence]',
      );
      process.exit(0);
    }
  }
  return { onlySupplierId, ignoreCadence };
}

async function main() {
  const args = parseArgs(process.argv);
  const outcomes = await runSupplierPoll(args);
  for (const o of outcomes) {
    if (o.skippedBecause) {
      console.log(
        `[supplier-poll] ${o.supplierSlug} — skipped (${o.skippedBecause})`,
      );
    } else if (o.errorMessage) {
      console.error(
        `[supplier-poll] ${o.supplierSlug} — FAILED: ${o.errorMessage}`,
      );
    } else {
      console.log(
        `[supplier-poll] ${o.supplierSlug} — ${o.productsUpdated}/${o.productsChecked} updated`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error('[supplier-poll] FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
