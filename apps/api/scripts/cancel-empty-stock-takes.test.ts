/**
 * Clearing away the empty sheets: only OPEN takes with nothing counted, only
 * once they are old enough not to be someone's count just started, and never
 * a sheet with counts on it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, sites, stockTakeLines, stockTakes } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { StockTakeService } from '../src/modules/stock-take/stock-take.service.js';
import { cancelEmptyStockTakes } from './cancel-empty-stock-takes.js';

const C = getSingletonCompanyId();
const svc = new StockTakeService();
let siteIds: string[] = [];
let productId: string;

async function cleanUp() {
  const db = getDb();
  if (siteIds.length) {
    const takes = await db.select({ id: stockTakes.id }).from(stockTakes).where(inArray(stockTakes.siteId, siteIds));
    if (takes.length) await db.delete(stockTakeLines).where(inArray(stockTakeLines.stockTakeId, takes.map((t) => t.id)));
    await db.delete(stockTakes).where(inArray(stockTakes.siteId, siteIds));
    await db.delete(sites).where(inArray(sites.id, siteIds));
  }
  if (productId) await db.delete(products).where(eq(products.id, productId));
  siteIds = [];
}

beforeEach(async () => {
  await cleanUp();
  const db = getDb();
  const made = await db
    .insert(sites)
    .values(['a', 'b', 'c'].map((x) => ({ companyId: C, slug: `cet-${x}`, name: `CET ${x}`, canonicalName: `CET ${x}` })))
    .returning();
  siteIds = made.map((s) => s.id);
  const [p] = await db.insert(products).values({ companyId: C, name: 'CET Flour', slug: 'cet-flour', stockUom: 'kg' }).returning();
  productId = p!.id;
});

afterAll(async () => {
  await cleanUp();
  await closeDatabase();
});

describe('cancelEmptyStockTakes', () => {
  it('cancels old empty sheets only; keeps sheets with counts and ones just opened', async () => {
    const db = getDb();
    const { take: oldEmpty } = await svc.open({ siteId: siteIds[0]!, scope: 'FULL' });
    const { take: oldCounted } = await svc.open({ siteId: siteIds[1]!, scope: 'FULL' });
    await svc.recordCounts(oldCounted.id, [{ productId, countedQty: 3 }]);
    const { take: freshEmpty } = await svc.open({ siteId: siteIds[2]!, scope: 'FULL' });
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    await db.update(stockTakes).set({ createdAt: dayAgo }).where(inArray(stockTakes.id, [oldEmpty.id, oldCounted.id]));

    const dry = await cancelEmptyStockTakes();
    const mine = (ids: string[]) => ids.filter((id) => [oldEmpty.id, oldCounted.id, freshEmpty.id].includes(id));
    expect(mine(dry.results.map((r) => r.id))).toEqual([oldEmpty.id]);
    expect((await svc.get(oldEmpty.id))!.take.status).toBe('OPEN'); // a dry run changes nothing

    await cancelEmptyStockTakes({ apply: true });
    expect((await svc.get(oldEmpty.id))!.take.status).toBe('CANCELLED');
    expect((await svc.get(oldCounted.id))!.take.status).toBe('OPEN');
    expect((await svc.get(freshEmpty.id))!.take.status).toBe('OPEN');
  });
});
