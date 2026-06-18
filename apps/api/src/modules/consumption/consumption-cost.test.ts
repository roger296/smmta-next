/**
 * Per-session materials cost → BumbleBee + daily COGS/wastage → Xero (P17,
 * spec §A8). Real Postgres, isolated company.
 *
 * Covers: materials cost = Σ(actual × unit cost); the BumbleBee push is
 * dry-run-safe + idempotent; the daily sweep posts one balanced COGS + one
 * wastage journal per site/day and is a no-op on re-run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  bumblebeeSyncLog,
  glPostingLog,
  products,
  recipeLines,
  recipes,
  sessionConsumption,
  sessionConsumptionLines,
  sites,
  stockLevels,
  stockMovements,
} from '../../db/schema/index.js';
import { RecipeService } from '../recipes/recipe.service.js';
import { SessionConsumptionService } from './session-consumption.service.js';
import { MaterialsCostSyncService } from './materials-cost-sync.service.js';
import { ConsumptionSweepService } from './consumption-sweep.service.js';

const COMPANY = 'f7f7f7f7-f7f7-4f7f-8f7f-f7f7f7f7f7f7';
const consume = new SessionConsumptionService();
const costSync = new MaterialsCostSyncService();
const sweep = new ConsumptionSweepService();
const recipeSvc = new RecipeService();

let siteId: string;
let flourId: string;
const DATE = '2026-06-18';
const SESSION = 'p17-sess';

async function clear(): Promise<void> {
  const db = getDb();
  await db.delete(bumblebeeSyncLog).where(eq(bumblebeeSyncLog.companyId, COMPANY));
  await db.delete(sessionConsumptionLines).where(eq(sessionConsumptionLines.companyId, COMPANY));
  await db.delete(sessionConsumption).where(eq(sessionConsumption.companyId, COMPANY));
  await db.delete(glPostingLog).where(eq(glPostingLog.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

async function submitOne(): Promise<void> {
  await getDb().insert(stockLevels).values({ companyId: COMPANY, productId: flourId, siteId, onHand: '5000' });
  await consume.submit({
    sessionId: SESSION,
    siteId,
    sessionDate: DATE,
    bakerName: 'Pat',
    coverGroups: [{ experience: 'CLASSIC', covers: 8 }],
    lines: [{ productId: flourId, actualQty: 750, wastageQty: 50, wastageReason: 'spill' }],
    companyId: COMPANY,
  });
}

beforeAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));

  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'P17 Flour', slug: 'p17-flour', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.05' })
    .returning();
  flourId = f!.id;
  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'p17-site', name: 'P17 Site', canonicalName: 'P17 Site' })
    .returning();
  siteId = site!.id;
  await recipeSvc.create({
    experience: 'CLASSIC',
    effectiveFrom: '2026-01-01',
    lines: [{ productId: flourId, qtyPerCover: 100 }],
    companyId: COMPANY,
  });
});

beforeEach(clear);

afterAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

describe('materials cost → BumbleBee', () => {
  it('is computed as Σ(actual × unit cost) and pushed dry-run + idempotently', async () => {
    await submitOne();
    // materials cost = 750 × 0.05 = 37.50.
    const rec = await consume.getBySession(SESSION, COMPANY);
    expect(Number(rec!.record.materialsCost)).toBe(37.5);

    // The submit already fired one dry-run push; assert it landed.
    const rows = await getDb()
      .select()
      .from(bumblebeeSyncLog)
      .where(and(eq(bumblebeeSyncLog.companyId, COMPANY), eq(bumblebeeSyncLog.sourceKey, SESSION)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dryRun).toBe(true); // dry-run-safe (no BumbleBee endpoint)
    expect(rows[0]!.status).toBe('SUCCESS');
    expect(Number(rows[0]!.amount)).toBe(37.5);

    // A re-push of the same cost is a no-op (idempotent on the content hash).
    const result = await costSync.syncSession(SESSION, COMPANY);
    expect(result.idempotent).toBe(true);
    const after = await getDb()
      .select({ id: bumblebeeSyncLog.id })
      .from(bumblebeeSyncLog)
      .where(and(eq(bumblebeeSyncLog.companyId, COMPANY), eq(bumblebeeSyncLog.sourceKey, SESSION)));
    expect(after).toHaveLength(1); // still one row
  });
});

describe('daily COGS / wastage → Xero', () => {
  it('posts one balanced COGS + wastage journal per site/day, idempotent on re-run', async () => {
    await submitOne();

    const res = await sweep.runDaily({ date: DATE, companyId: COMPANY });
    expect(res.sites).toBe(1);
    expect(res.cogsPosted).toBe(1);
    expect(res.wastagePosted).toBe(1);
    expect(res.totalCogs).toBe(37.5); // 750 × 0.05
    expect(res.totalWastage).toBe(2.5); // 50 × 0.05

    const cogsKey = `CCOGS-${siteId}:${DATE}-v1`;
    const wasteKey = `WASTE-${siteId}:${DATE}-v1`;
    const postings = async (key: string) =>
      getDb().select({ status: glPostingLog.status }).from(glPostingLog).where(eq(glPostingLog.idempotencyKey, key));
    expect(await postings(cogsKey)).toHaveLength(1);
    expect((await postings(cogsKey))[0]!.status).toBe('SUCCESS'); // balanced + dry-run posted
    expect(await postings(wasteKey)).toHaveLength(1);

    // Re-run the sweep — idempotent no-op (no second journal).
    const again = await sweep.runDaily({ date: DATE, companyId: COMPANY });
    expect(again.cogsPosted).toBe(1); // the post is still attempted but the GL key is a no-op
    expect(await postings(cogsKey)).toHaveLength(1);
    expect(await postings(wasteKey)).toHaveLength(1);
  });
});
