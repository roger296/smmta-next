/**
 * Demand-based reorder (P22, spec §9). Real Postgres, isolated company.
 *
 * Covers: the estimator computes expected daily usage from a fixture; suggested
 * levels match a hand-computed value; with the per-site flag off the engine
 * keeps fixed-par behaviour and with it on it sizes from demand; accepting a
 * suggestion updates the level via the normal set-reorder-params path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { products, reorderProposals, sites, stockLevels, stockMovements } from '../../db/schema/index.js';
import { DemandEstimatorService } from './demand-estimator.service.js';
import { ReorderService } from './reorder.service.js';
import { StockLevelService } from '../stock/stock-level.service.js';

const COMPANY = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
const demand = new DemandEstimatorService();
const reorder = new ReorderService();
const levels = new StockLevelService();

let siteId: string;
let flourId: string;

async function clear(): Promise<void> {
  const db = getDb();
  await db.delete(reorderProposals).where(eq(reorderProposals.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.update(sites).set({ demandReorder: false }).where(eq(sites.companyId, COMPANY));
}

/** Insert a demand movement with an explicit date (no reorder hook). */
async function demandMovement(qty: number, occurredAt: Date, key: string): Promise<void> {
  await getDb().insert(stockMovements).values({
    companyId: COMPANY, productId: flourId, siteId, qtyDelta: String(-qty),
    movementType: 'CONSUMPTION', sourceSystem: 'test', sourceKey: key, contentHash: 'd', occurredAt,
  });
}

beforeAll(async () => {
  const db = getDb();
  await db.delete(reorderProposals).where(eq(reorderProposals.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'D2 Flour', slug: 'd2-flour', itemKind: 'INGREDIENT', stockUom: 'g', purchasePackSize: '1', purchaseToStockFactor: '1', expectedNextCost: '0.05' })
    .returning();
  flourId = f!.id;
  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'd2-site', name: 'D2 Site', canonicalName: 'D2 Site' })
    .returning();
  siteId = site!.id;
});

beforeEach(clear);

afterAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

describe('estimator', () => {
  it('computes average daily usage from the window', async () => {
    // 2800 consumed across the 28-day window ending 2026-06-18 → 100/day.
    await demandMovement(1400, new Date('2026-06-01T10:00:00Z'), 'm1');
    await demandMovement(1400, new Date('2026-06-15T10:00:00Z'), 'm2');
    // Outside the window — must be ignored.
    await demandMovement(9999, new Date('2026-01-01T10:00:00Z'), 'm3');

    const usage = await demand.dailyUsage({ productId: flourId, siteId, asOf: '2026-06-18', companyId: COMPANY });
    expect(usage).toBe(100); // 2800 / 28
  });

  it('suggests levels matching a hand-computed value', async () => {
    await demandMovement(2800, new Date('2026-06-10T10:00:00Z'), 'm1');
    const s = await demand.suggest({
      productId: flourId, siteId, leadTimeDays: 3, minDaysCover: 7, asOf: '2026-06-18', companyId: COMPANY,
    });
    expect(s.dailyUsage).toBe(100);
    expect(s.suggestedReorderPoint).toBe(300); // 100 × 3
    expect(s.suggestedReorderUpTo).toBe(1000); // 100 × (3 + 7)
  });
});

describe('reorder engine integration', () => {
  it('flag off keeps fixed par; flag on sizes from demand', async () => {
    // Demand history → 100/day (occurred "now" so the engine's today-window sees it).
    await getDb().insert(stockMovements).values({
      companyId: COMPANY, productId: flourId, siteId, qtyDelta: '-2800',
      movementType: 'CONSUMPTION', sourceSystem: 'test', sourceKey: 'now', contentHash: 'd',
    });
    await getDb().insert(stockLevels).values({
      companyId: COMPANY, productId: flourId, siteId, onHand: '200',
      reorderPoint: '1000', reorderUpTo: '2000', minDaysCover: 7,
    });

    // Flag off → fixed par 2000 → order 2000 − 200 = 1800.
    const off = await reorder.evaluate(flourId, siteId, { companyId: COMPANY, triggeredBy: 'manual' });
    const offProposal = await getDb().query.reorderProposals.findFirst({ where: eq(reorderProposals.id, off.proposalId!) });
    expect(Number(offProposal!.suggestedQtyStock)).toBe(1800);

    // Turn the site flag on, clear the proposal, re-evaluate.
    await getDb().update(sites).set({ demandReorder: true }).where(eq(sites.id, siteId));
    await getDb().delete(reorderProposals).where(eq(reorderProposals.companyId, COMPANY));
    const on = await reorder.evaluate(flourId, siteId, { companyId: COMPANY, triggeredBy: 'manual' });
    const onProposal = await getDb().query.reorderProposals.findFirst({ where: eq(reorderProposals.id, on.proposalId!) });
    // demand up-to = 100 × (3 + 7) = 1000 → order 1000 − 200 = 800.
    expect(Number(onProposal!.suggestedQtyStock)).toBe(800);
  });
});

describe('accept', () => {
  it('accepting a suggestion updates the level via the normal path', async () => {
    await getDb().insert(stockLevels).values({ companyId: COMPANY, productId: flourId, siteId, onHand: '0' });
    await levels.setReorderParams({ productId: flourId, siteId, reorderPoint: 300, reorderUpTo: 1000, companyId: COMPANY });
    const level = await getDb().query.stockLevels.findFirst({
      where: eq(stockLevels.productId, flourId),
    });
    expect(Number(level!.reorderPoint)).toBe(300);
    expect(Number(level!.reorderUpTo)).toBe(1000);
  });
});
