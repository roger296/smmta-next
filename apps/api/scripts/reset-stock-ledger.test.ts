/**
 * Zeroing the stock position for go-live.
 *
 * The case that matters is the ledger: on_hand is a CACHE of
 * sum(qty_delta), so a reset that leaves the movements behind is undone by the
 * next reconcile — quietly, and with nobody watching for it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, sites, stockLevels, stockMovements } from '../src/db/schema/index.js';
import { StockLevelService } from '../src/modules/stock/stock-level.service.js';
import { resetStockLedger } from './reset-stock-ledger.js';

const COMPANY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PREFIX = 'RESET';

let productId: string;
let siteId: string;

async function wipe() {
  const db = getDb();
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  const ids = ps.map((p) => p.id);
  if (ids.length > 0) {
    await db.delete(stockMovements).where(inArray(stockMovements.productId, ids));
    await db.delete(stockLevels).where(inArray(stockLevels.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  }
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
}

beforeEach(async () => {
  await wipe();
  const db = getDb();
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Reset Test Flour', stockCode: `${PREFIX}-001`, stockUom: 'kg' })
    .returning();
  productId = p!.id;
  const [s] = await db
    .insert(sites)
    .values({ companyId: COMPANY, name: 'Reset Site', canonicalName: 'Reset Site', slug: `${PREFIX}-site` })
    .returning();
  siteId = s!.id;
  await db.insert(stockMovements).values([
    { companyId: COMPANY, productId, siteId, qtyDelta: '40', movementType: 'GRN', sourceSystem: 'TEST', sourceKey: `${PREFIX}-1`, contentHash: `${PREFIX}-h1` },
    { companyId: COMPANY, productId, siteId, qtyDelta: '-15', movementType: 'CONSUMPTION', sourceSystem: 'TEST', sourceKey: `${PREFIX}-2`, contentHash: `${PREFIX}-h2` },
  ]);
  await db.insert(stockLevels).values({
    companyId: COMPANY, productId, siteId, onHand: '25', allocated: '5',
    reorderPoint: '10', reorderUpTo: '50', minDaysCover: 7,
  });
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

const level = async () =>
  (await getDb().select().from(stockLevels).where(and(eq(stockLevels.productId, productId), eq(stockLevels.siteId, siteId))))[0]!;

describe('resetStockLedger', () => {
  it('reports what it would do and writes nothing on a dry run', async () => {
    const r = await resetStockLedger({ companyId: COMPANY });
    expect(r).toMatchObject({ dryRun: true, movementsCleared: 2, levelsZeroed: 1, totalOnHandBefore: 25 });
    const l = await level();
    expect(Number(l.onHand)).toBe(25);
    expect((await getDb().select().from(stockMovements).where(eq(stockMovements.productId, productId)))).toHaveLength(2);
  });

  it('zeroes the level and clears the ledger on --apply', async () => {
    await resetStockLedger({ companyId: COMPANY, apply: true });
    const l = await level();
    expect(Number(l.onHand)).toBe(0);
    expect(Number(l.allocated)).toBe(0);
    expect(await getDb().select().from(stockMovements).where(eq(stockMovements.productId, productId))).toHaveLength(0);
  });

  /**
   * The whole reason the ledger has to go. Leave the movements and the next
   * reconcile puts every invented number straight back.
   */
  it('stays zero when the cache is recomputed from the ledger afterwards', async () => {
    await resetStockLedger({ companyId: COMPANY, apply: true });
    const after = await new StockLevelService().recomputeOnHand(productId, siteId, COMPANY);
    expect(Number(after)).toBe(0);
    expect(Number((await level()).onHand)).toBe(0);
  });

  /** Reorder points are configuration — somebody chose them, and they are
   *  still right at zero stock. */
  it('keeps the reorder configuration', async () => {
    await resetStockLedger({ companyId: COMPANY, apply: true });
    const l = await level();
    expect(Number(l.reorderPoint)).toBe(10);
    expect(Number(l.reorderUpTo)).toBe(50);
    expect(l.minDaysCover).toBe(7);
  });

  it('keeps the stock_levels row, so a product stays set up for its site', async () => {
    await resetStockLedger({ companyId: COMPANY, apply: true });
    expect(await getDb().select().from(stockLevels).where(eq(stockLevels.productId, productId))).toHaveLength(1);
  });

  it('is idempotent — a second run finds nothing left to clear', async () => {
    await resetStockLedger({ companyId: COMPANY, apply: true });
    const second = await resetStockLedger({ companyId: COMPANY });
    expect(second).toMatchObject({ movementsCleared: 0, levelsZeroed: 0, totalOnHandBefore: 0 });
    expect(second.levelsAlreadyZero).toBe(1);
  });
});
