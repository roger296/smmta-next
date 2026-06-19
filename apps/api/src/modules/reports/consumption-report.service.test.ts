/**
 * Consumption / wastage / food-cost reports (P18, spec §4/§A6). Real Postgres.
 *
 * Covers: the variance report reconciles expected / actual / counted on a
 * fixture; food-cost % matches a hand-computed value; shrinkage = counted −
 * book; the period filter excludes out-of-window sessions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
  stockTakeLines,
  stockTakes,
} from '../../db/schema/index.js';
import { RecipeService } from '../recipes/recipe.service.js';
import { SessionConsumptionService } from '../consumption/session-consumption.service.js';
import { StockTakeService } from '../stock-take/stock-take.service.js';
import { ConsumptionReportService } from './consumption-report.service.js';

const COMPANY = 'a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8';
const consume = new SessionConsumptionService();
const takes = new StockTakeService();
const reports = new ConsumptionReportService();
const recipeSvc = new RecipeService();

let siteId: string;
let flourId: string;

const WIDE = { from: '2000-01-01', to: '2099-12-31', companyId: COMPANY };

async function clear(): Promise<void> {
  const db = getDb();
  await db.delete(bumblebeeSyncLog).where(eq(bumblebeeSyncLog.companyId, COMPANY));
  await db.delete(sessionConsumptionLines).where(eq(sessionConsumptionLines.companyId, COMPANY));
  await db.delete(sessionConsumption).where(eq(sessionConsumption.companyId, COMPANY));
  const tks = await db.select({ id: stockTakes.id }).from(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  for (const t of tks) await db.delete(stockTakeLines).where(eq(stockTakeLines.stockTakeId, t.id));
  await db.delete(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  await db.delete(glPostingLog).where(eq(glPostingLog.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

async function submit(sessionId: string, date: string, actual: number, wastage = 0): Promise<void> {
  await consume.submit({
    sessionId,
    siteId,
    sessionDate: date,
    bakerName: 'Rep',
    bake: 'Victoria Sponge',
    covers: 8,
    lines: [{ productId: flourId, actualQty: actual, wastageQty: wastage, wastageReason: wastage ? 'spill' : null }],
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
    .values({ companyId: COMPANY, name: 'Rep Flour', slug: 'rep-flour', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.05' })
    .returning();
  flourId = f!.id;
  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'rep-site', name: 'Rep Site', canonicalName: 'Rep Site' })
    .returning();
  siteId = site!.id;
  await recipeSvc.create({
    bake: 'Victoria Sponge',
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

describe('consumption variance', () => {
  it('reconciles expected / actual and includes shrinkage (counted − book)', async () => {
    await getDb().insert(stockLevels).values({ companyId: COMPANY, productId: flourId, siteId, onHand: '5000' });
    await submit('v-1', '2026-06-18', 750, 50); // expected 800

    // A stock-take: book 4200 (5000 − 750 − 50), counted 4150 → variance −50.
    const { take } = await takes.open({ siteId, scope: 'FULL', companyId: COMPANY });
    await takes.recordCounts(take.id, [{ productId: flourId, countedQty: 4150 }]);
    await takes.approve(take.id, COMPANY);

    const rows = await reports.consumptionVariance(WIDE);
    const flour = rows.find((r) => r.productId === flourId)!;
    expect(flour.expectedQty).toBe(800);
    expect(flour.actualQty).toBe(750);
    expect(flour.varianceQty).toBe(-50); // portion drift
    expect(flour.variancePct).toBe(-6.25); // −50 / 800
    expect(flour.expectedCost).toBe(40); // 800 × 0.05
    expect(flour.actualCost).toBe(37.5);
    expect(flour.shrinkageQty).toBe(-50); // counted − book
    expect(flour.shrinkageCost).toBe(-2.5);
  });
});

describe('food cost', () => {
  it('computes food-cost % against revenue and cost per cover', async () => {
    await getDb().insert(stockLevels).values({ companyId: COMPANY, productId: flourId, siteId, onHand: '5000' });
    await submit('fc-1', '2026-06-18', 750); // materials cost 37.50, covers 8

    const rows = await reports.foodCost({ ...WIDE, siteId, revenue: 150 });
    const site = rows[0]!;
    expect(site.actualCost).toBe(37.5);
    expect(site.covers).toBe(8);
    expect(site.costPerCover).toBe(4.69); // 37.5 / 8
    expect(site.foodCostPct).toBe(25); // 37.5 / 150 × 100
  });
});

describe('wastage', () => {
  it('reports wastage hot-spots with reasons', async () => {
    await getDb().insert(stockLevels).values({ companyId: COMPANY, productId: flourId, siteId, onHand: '5000' });
    await submit('w-1', '2026-06-18', 700, 30);
    const rows = await reports.wastage(WIDE);
    const flour = rows.find((r) => r.productId === flourId)!;
    expect(flour.wastageQty).toBe(30);
    expect(flour.wastageCost).toBe(1.5); // 30 × 0.05
    expect(flour.reasons).toContain('spill');
  });
});

describe('period filter', () => {
  it('excludes sessions outside the window', async () => {
    await getDb().insert(stockLevels).values({ companyId: COMPANY, productId: flourId, siteId, onHand: '10000' });
    await submit('p-jun', '2026-06-18', 750);
    await submit('p-jul', '2026-07-10', 600);

    const june = await reports.consumptionVariance({ from: '2026-06-01', to: '2026-06-30', companyId: COMPANY });
    expect(june.find((r) => r.productId === flourId)!.actualQty).toBe(750); // July excluded
  });
});
