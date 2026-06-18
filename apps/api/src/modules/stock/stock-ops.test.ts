/**
 * Ledger stock operations (P4, spec §A5): adjust, inter-site transfer,
 * WAC valuation and low-stock. Real Postgres, isolated to a dedicated company.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { products, sites, stockLevels, stockMovements } from '../../db/schema/index.js';
import { StockLevelService } from './stock-level.service.js';
import { StockQueryService } from './stock-query.service.js';

const COMPANY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const levels = new StockLevelService();
const query = new StockQueryService();

let sugarId: string;
let cookieId: string;
let siteAId: string;
let siteBId: string;

async function wipeStock(): Promise<void> {
  const db = getDb();
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await wipeStock();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  const [sugar] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Sugar', slug: 'ops-sugar', itemKind: 'INGREDIENT', stockUom: 'g' })
    .returning();
  const [cookie] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Cookie', slug: 'ops-cookie', itemKind: 'RETAIL', stockUom: 'each' })
    .returning();
  sugarId = sugar!.id;
  cookieId = cookie!.id;
  const [a] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'ops-a', name: 'Ops A', canonicalName: 'Ops A' })
    .returning();
  const [b] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'ops-b', name: 'Ops B', canonicalName: 'Ops B' })
    .returning();
  siteAId = a!.id;
  siteBId = b!.id;
});

afterAll(async () => {
  const db = getDb();
  await wipeStock();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

beforeEach(wipeStock);

describe('adjust', () => {
  it('writes an ADJUSTMENT movement and trues up on-hand', async () => {
    const res = await levels.adjust({ productId: cookieId, siteId: siteAId, qtyDelta: 12, companyId: COMPANY });
    expect(res.applied).toBe(true);
    expect(Number(res.onHand)).toBe(12);
    const movs = await getDb()
      .select({ type: stockMovements.movementType })
      .from(stockMovements)
      .where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.productId, cookieId)));
    expect(movs).toHaveLength(1);
    expect(movs[0]!.type).toBe('ADJUSTMENT');
  });
});

describe('transfer', () => {
  it('conserves total quantity across two sites', async () => {
    await levels.adjust({ productId: cookieId, siteId: siteAId, qtyDelta: 10, companyId: COMPANY });
    await levels.transfer({ productId: cookieId, fromSiteId: siteAId, toSiteId: siteBId, qty: 4, companyId: COMPANY });

    const atA = Number(await levels.getOnHand(cookieId, siteAId, COMPANY));
    const atB = Number(await levels.getOnHand(cookieId, siteBId, COMPANY));
    expect(atA).toBe(6);
    expect(atB).toBe(4);
    expect(atA + atB).toBe(10); // conserved
  });

  it('rejects a same-site transfer', async () => {
    await expect(
      levels.transfer({ productId: cookieId, fromSiteId: siteAId, toSiteId: siteAId, qty: 1, companyId: COMPANY }),
    ).rejects.toThrow();
  });
});

describe('valuation (WAC)', () => {
  it('matches a hand-computed fixture', async () => {
    // Sugar: 1000 g @ 0.002 then 1000 g @ 0.004 → WAC 0.003, on-hand 2000 → £6.00.
    await levels.applyMovement({
      productId: sugarId, siteId: siteAId, qtyDelta: 1000, movementType: 'GRN',
      sourceSystem: 'test', sourceKey: 'g1', contentHash: 'h1', unitCost: 0.002, companyId: COMPANY,
    });
    await levels.applyMovement({
      productId: sugarId, siteId: siteAId, qtyDelta: 1000, movementType: 'GRN',
      sourceSystem: 'test', sourceKey: 'g2', contentHash: 'h2', unitCost: 0.004, companyId: COMPANY,
    });
    // Cookie: 10 @ 0.50 → £5.00.
    await levels.applyMovement({
      productId: cookieId, siteId: siteAId, qtyDelta: 10, movementType: 'GRN',
      sourceSystem: 'test', sourceKey: 'g3', contentHash: 'h3', unitCost: 0.5, companyId: COMPANY,
    });

    const val = await query.valuation({ siteId: siteAId, companyId: COMPANY });
    expect(val.total).toBeCloseTo(11, 5);
    expect(val.bySite).toEqual([{ siteId: siteAId, currencyCode: 'GBP', value: expect.closeTo(11, 5) }]);
    const ingredient = val.byItemKind.find((r) => r.itemKind === 'INGREDIENT');
    const retail = val.byItemKind.find((r) => r.itemKind === 'RETAIL');
    expect(ingredient!.value).toBeCloseTo(6, 5);
    expect(retail!.value).toBeCloseTo(5, 5);
  });
});

describe('low stock', () => {
  it('returns exactly the items at or below their reorder point', async () => {
    await levels.adjust({ productId: sugarId, siteId: siteAId, qtyDelta: 2000, companyId: COMPANY });
    await levels.adjust({ productId: cookieId, siteId: siteAId, qtyDelta: 10, companyId: COMPANY });
    const db = getDb();
    // Sugar low (point 2500 > 2000); cookie healthy (point 5 < 10).
    await db.update(stockLevels).set({ reorderPoint: '2500' })
      .where(and(eq(stockLevels.companyId, COMPANY), eq(stockLevels.productId, sugarId), eq(stockLevels.siteId, siteAId)));
    await db.update(stockLevels).set({ reorderPoint: '5' })
      .where(and(eq(stockLevels.companyId, COMPANY), eq(stockLevels.productId, cookieId), eq(stockLevels.siteId, siteAId)));

    const low = await query.lowStock({ siteId: siteAId, companyId: COMPANY });
    const ids = low.map((r) => r.productId);
    expect(ids).toContain(sugarId);
    expect(ids).not.toContain(cookieId);
    expect(low).toHaveLength(1);
  });
});
