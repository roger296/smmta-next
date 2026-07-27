/**
 * Give every product a reorder point at every site.
 *
 *   npx tsx apps/api/scripts/seed-reorder-levels.ts --dry-run
 *   npx tsx apps/api/scripts/seed-reorder-levels.ts               # point = 5
 *   npx tsx apps/api/scripts/seed-reorder-levels.ts --point 5 --up-to 20
 *   npx tsx apps/api/scripts/seed-reorder-levels.ts --force       # overwrite tuned values
 *
 * A flat starting point, in each product's own stock unit — 5 means 5kg of
 * flour and 5 bottles of vanilla. Crude on purpose: the demand estimator can
 * do far better, but it reads SALE/CONSUMPTION history and there isn't any
 * yet, so a flat floor is what turns "nothing is tracked" into "something
 * flags when it runs low". These are meant to be tuned per item afterwards.
 *
 * SAFE TO RE-RUN: by default it only fills sites/products whose reorder point
 * is still unset, so tuning survives. `--force` overwrites everything, which
 * is the one way to lose hand-set levels.
 */
import 'dotenv/config';
import { and, eq, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, sites, stockLevels } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

export interface SeedLevelsReport {
  products: number;
  sites: number;
  pairs: number;
  set: number;
  leftAlone: number;
}

/** Chunked so a few thousand rows don't become one enormous statement. */
const CHUNK = 500;

export async function seedReorderLevels(opts: {
  point: number;
  upTo?: number | null;
  dryRun?: boolean;
  force?: boolean;
}): Promise<SeedLevelsReport> {
  const companyId = getSingletonCompanyId();
  const db = getDb();

  const [productRows, siteRows] = await Promise.all([
    db.query.products.findMany({
      where: eq(products.companyId, companyId),
      columns: { id: true },
    }),
    db.query.sites.findMany({ where: eq(sites.companyId, companyId), columns: { id: true } }),
  ]);

  const report: SeedLevelsReport = {
    products: productRows.length,
    sites: siteRows.length,
    pairs: productRows.length * siteRows.length,
    set: 0,
    leftAlone: 0,
  };
  if (report.pairs === 0) return report;

  // Which pairs already carry a hand-set point? Those are left alone unless
  // forced — re-running this must never quietly undo someone's tuning.
  const existing = await db.query.stockLevels.findMany({
    where: eq(stockLevels.companyId, companyId),
    columns: { productId: true, siteId: true, reorderPoint: true },
  });
  const alreadySet = new Set(
    existing.filter((l) => l.reorderPoint != null).map((l) => `${l.productId} ${l.siteId}`),
  );

  const wanted: Array<{ productId: string; siteId: string }> = [];
  for (const p of productRows) {
    for (const s of siteRows) {
      if (!opts.force && alreadySet.has(`${p.id} ${s.id}`)) {
        report.leftAlone += 1;
        continue;
      }
      wanted.push({ productId: p.id, siteId: s.id });
    }
  }
  report.set = wanted.length;
  if (opts.dryRun) return report;

  const point = String(opts.point);
  const upTo = opts.upTo != null ? String(opts.upTo) : null;

  for (let i = 0; i < wanted.length; i += CHUNK) {
    const batch = wanted.slice(i, i + CHUNK);
    await db
      .insert(stockLevels)
      .values(
        batch.map((w) => ({
          companyId,
          productId: w.productId,
          siteId: w.siteId,
          // A level row may not exist yet; on-hand stays 0 until something is
          // actually counted. Setting a reorder point is not a stock movement.
          onHand: '0',
          reorderPoint: point,
          reorderUpTo: upTo,
        })),
      )
      .onConflictDoUpdate({
        target: [stockLevels.companyId, stockLevels.productId, stockLevels.siteId],
        // Only the reorder columns — never touch on_hand, which the ledger owns.
        set: upTo != null
          ? { reorderPoint: point, reorderUpTo: upTo, updatedAt: new Date() }
          : { reorderPoint: point, updatedAt: new Date() },
      });
  }

  return report;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isCliEntry = process.argv[1]?.endsWith('seed-reorder-levels.ts') ?? false;

if (isCliEntry) {
  const point = Number(arg('point') ?? 5);
  const upToRaw = arg('up-to');
  const upTo = upToRaw != null ? Number(upToRaw) : null;
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');

  if (!Number.isFinite(point) || point < 0) {
    console.error('[seed-reorder-levels] --point must be a non-negative number');
    process.exit(2);
  }
  if (upTo != null && (!Number.isFinite(upTo) || upTo < point)) {
    console.error('[seed-reorder-levels] --up-to must be >= --point');
    process.exit(2);
  }

  seedReorderLevels({ point, upTo, dryRun, force })
    .then((r) => {
      console.log(`[seed-reorder-levels] ${dryRun ? 'DRY RUN — nothing written' : 'OK'}`);
      console.log(`  ${r.products} products x ${r.sites} sites = ${r.pairs} pairs`);
      console.log(`  reorder point ${point}${upTo != null ? `, order up to ${upTo}` : ''}`);
      console.log(`  ${dryRun ? 'would set' : 'set'}: ${r.set}`);
      console.log(`  left alone (already had a point): ${r.leftAlone}${force ? ' — OVERWRITTEN by --force' : ''}`);
      if (upTo == null) {
        console.log('');
        console.log('  Note: with no --up-to, an order tops stock back up to the point');
        console.log('  itself, so proposals will be small and nothing triggers at exactly');
        console.log('  the point. Set --up-to above the point when you know the numbers.');
      }
    })
    .catch((err) => {
      console.error('[seed-reorder-levels] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
