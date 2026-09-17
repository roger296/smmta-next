/**
 * Zero the stock position, ready for the first real count.
 *
 *   npx tsx apps/api/scripts/reset-stock-ledger.ts            # dry run
 *   npx tsx apps/api/scripts/reset-stock-ledger.ts --apply
 *
 * A GO-LIVE STEP, not a maintenance one. Every quantity in the system today
 * came out of user testing — invented counts, invented bakes, invented
 * goods-in. None of it describes what is on a shelf. Carrying it into the
 * first real stock-take would make every variance meaningless and every
 * reorder proposal wrong, so the position is zeroed and the venues count from
 * scratch.
 *
 * ⚠️ IT MUST CLEAR THE LEDGER, NOT JUST THE LEVELS. `stock_levels.on_hand` is
 * a CACHE of `sum(stock_movements.qty_delta)` — `StockLevelService
 * .recomputeOnHand` re-derives it from the ledger and writes it back. Zero the
 * levels while leaving the movements and the next reconcile silently restores
 * every made-up number, with nobody watching for it.
 *
 * WHAT IT KEEPS. Reorder points, reorder-up-to levels and days-of-cover are
 * CONFIGURATION, not stock — somebody chose them, and they are still right at
 * zero. The stock_levels rows themselves are kept too (zeroed), so a product
 * that was set up for a site stays set up for it.
 *
 * WHAT IT DOES NOT TOUCH. Consumption history, stock-takes, wastage events and
 * goods-in receipts are the RECORD of the testing, not the position. Deleting
 * them is a wider blast radius than "set the levels to zero" and a separate
 * decision, so they are counted and reported for the operator to weigh rather
 * than quietly removed.
 */
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  goodsInReceiptLines,
  goodsInReceipts,
  sessionConsumptionLines,
  stockBatches,
  stockLevels,
  stockMovements,
  stockTakeLines,
  stockTakes,
  wastageEvents,
} from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

export interface ResetReport {
  dryRun: boolean;
  /** Cleared: the ledger behind the position. */
  movementsCleared: number;
  batchesCleared: number;
  /** Zeroed in place; reorder configuration kept. */
  levelsZeroed: number;
  levelsAlreadyZero: number;
  totalOnHandBefore: number;
  /** Left alone, reported so the operator can decide separately. */
  historyKept: Array<{ what: string; rows: number }>;
}

const N = sql<number>`count(*)::int`;

/**
 * Receipt lines and stock-take lines carry no company_id of their own — they
 * hang off a header that does. Counting them without the join would either
 * fail or, worse, count another company's rows.
 */
async function countHistory(companyId: string) {
  const db = getDb();
  const [consumption] = await db
    .select({ n: N })
    .from(sessionConsumptionLines)
    .where(eq(sessionConsumptionLines.companyId, companyId));
  const [wastage] = await db
    .select({ n: N })
    .from(wastageEvents)
    .where(eq(wastageEvents.companyId, companyId));
  const [takes] = await db
    .select({ n: N })
    .from(stockTakeLines)
    .innerJoin(stockTakes, eq(stockTakes.id, stockTakeLines.stockTakeId))
    .where(eq(stockTakes.companyId, companyId));
  const [goodsIn] = await db
    .select({ n: N })
    .from(goodsInReceiptLines)
    .innerJoin(goodsInReceipts, eq(goodsInReceipts.id, goodsInReceiptLines.receiptId))
    .where(eq(goodsInReceipts.companyId, companyId));
  return [
    { what: 'consumption lines (end-of-bake)', rows: consumption?.n ?? 0 },
    { what: 'stock-take lines', rows: takes?.n ?? 0 },
    { what: 'wastage events', rows: wastage?.n ?? 0 },
    { what: 'goods-in receipt lines', rows: goodsIn?.n ?? 0 },
  ];
}

export async function resetStockLedger(
  opts: { apply?: boolean; companyId?: string } = {},
): Promise<ResetReport> {
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const apply = opts.apply ?? false;
  const db = getDb();

  const [before] = await db
    .select({
      levels: sql<number>`count(*)::int`,
      nonZero: sql<number>`count(*) filter (where ${stockLevels.onHand} <> 0 or ${stockLevels.allocated} <> 0)::int`,
      total: sql<string>`coalesce(sum(${stockLevels.onHand}), 0)::text`,
    })
    .from(stockLevels)
    .where(eq(stockLevels.companyId, companyId));

  const db2 = getDb();
  const [mv] = await db2
    .select({ n: N })
    .from(stockMovements)
    .where(eq(stockMovements.companyId, companyId));
  const [bt] = await db2
    .select({ n: N })
    .from(stockBatches)
    .where(eq(stockBatches.companyId, companyId));
  const movements = mv?.n ?? 0;
  const batches = bt?.n ?? 0;

  const report: ResetReport = {
    dryRun: !apply,
    movementsCleared: movements,
    batchesCleared: batches,
    levelsZeroed: before?.nonZero ?? 0,
    levelsAlreadyZero: (before?.levels ?? 0) - (before?.nonZero ?? 0),
    totalOnHandBefore: Number(before?.total ?? 0),
    historyKept: await countHistory(companyId),
  };

  if (!apply) return report;

  // One transaction: a half-reset — ledger gone, levels still carrying numbers,
  // or the reverse — is a position nobody can explain and no report would
  // flag.
  await db.transaction(async (tx) => {
    await tx.delete(stockMovements).where(eq(stockMovements.companyId, companyId));
    await tx.delete(stockBatches).where(eq(stockBatches.companyId, companyId));
    await tx
      .update(stockLevels)
      .set({ onHand: '0', allocated: '0', updatedAt: new Date() })
      .where(eq(stockLevels.companyId, companyId));
  });
  return report;
}

const isCliEntry = process.argv[1]?.endsWith('reset-stock-ledger.ts') ?? false;

if (isCliEntry) {
  const apply = process.argv.includes('--apply');
  resetStockLedger({ apply })
    .then((r) => {
      console.log(
        `[reset-stock-ledger] ${r.dryRun ? 'DRY RUN - nothing written (pass --apply to commit)' : 'APPLIED'}`,
      );
      console.log(`  stock movements cleared : ${r.movementsCleared}`);
      console.log(`  stock batches cleared   : ${r.batchesCleared}`);
      console.log(`  stock levels zeroed     : ${r.levelsZeroed}  (${r.levelsAlreadyZero} already at zero)`);
      console.log(`  on-hand discarded       : ${r.totalOnHandBefore}`);
      console.log('\n  Reorder points / up-to levels / days cover are KEPT - they are');
      console.log('  configuration, and still right at zero stock.');
      const kept = r.historyKept.filter((h) => h.rows > 0);
      if (kept.length > 0) {
        console.log('\n  NOT touched - the record of the testing, not the position:');
        for (const h of kept) console.log(`    ${String(h.rows).padStart(6)}  ${h.what}`);
        console.log('  Clearing those is a separate decision; say so and it becomes a flag.');
      }
      if (r.dryRun) console.log('\n  Re-run with --apply when the venues are ready to count.');
    })
    .catch((err) => {
      console.error('[reset-stock-ledger] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
