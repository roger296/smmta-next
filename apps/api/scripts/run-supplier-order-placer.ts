/**
 * CLI entry point for the supplier-order-placer worker. The systemd
 * service `smmta-supplier-order-placer` runs this on a tight loop
 * (Type=simple with a sleep loop, or invoked by a quick timer) so
 * supplier orders move from PENDING → PLACED with a typical latency
 * under a minute.
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/run-supplier-order-placer.ts
 *
 * Optional flags:
 *   --batch-size <n>    cap rows per run (default 50)
 *   --once              run a single batch and exit (default behaviour)
 */
import 'dotenv/config';
import { closeDatabase } from '../src/config/database.js';
import { runSupplierOrderPlacer } from '../src/workers/supplier-order-placer.worker.js';

function parseArgs(argv: string[]) {
  let batchSize = 50;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--batch-size' && argv[i + 1]) {
      batchSize = Number(argv[++i]);
    } else if (flag === '--help' || flag === '-h') {
      console.error('Usage: tsx run-supplier-order-placer.ts [--batch-size n]');
      process.exit(0);
    }
  }
  return { batchSize };
}

async function main() {
  const args = parseArgs(process.argv);
  const outcomes = await runSupplierOrderPlacer(args);
  for (const o of outcomes) {
    console.log(`[placer] ${o.supplierOrderId} — ${o.result}${o.errorMessage ? ` — ${o.errorMessage}` : ''}`);
  }
}

main()
  .catch((err) => {
    console.error('[placer] FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
