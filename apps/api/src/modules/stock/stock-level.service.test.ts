/**
 * StockLevelService — the per-(product, site) ledger (P2, spec §A5).
 *
 * Real Postgres at DATABASE_URL. Proves: a movement updates on-hand; the
 * cache equals Σ(qty_delta) after a randomised sequence; re-applying the same
 * idempotency key is a no-op; and a movement at one site never touches another.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { products, sites, stockLevels, stockMovements } from '../../db/schema/index.js';
import { StockLevelService } from './stock-level.service.js';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const svc = new StockLevelService();

let productId: string;
let siteAId: string;
let siteBId: string;

async function wipe(): Promise<void> {
  const db = getDb();
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
}

beforeAll(async () => {
  await wipe();
  const db = getDb();
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Stock Test Product', slug: 'stock-test-product' })
    .returning();
  productId = p!.id;
  const [a] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'stocktest-a', name: 'Stock Test A', canonicalName: 'Stock Test A' })
    .returning();
  const [b] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'stocktest-b', name: 'Stock Test B', canonicalName: 'Stock Test B' })
    .returning();
  siteAId = a!.id;
  siteBId = b!.id;
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

beforeEach(async () => {
  // Reset the ledger + cache between cases so on-hand assertions are absolute.
  const db = getDb();
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
});

describe('StockLevelService.applyMovement', () => {
  it('writes a movement and trues up on-hand', async () => {
    const res = await svc.applyMovement({
      productId,
      siteId: siteAId,
      qtyDelta: 10,
      movementType: 'GRN',
      sourceSystem: 'test-p2',
      sourceKey: 'm1',
      contentHash: 'h1',
      companyId: COMPANY,
    });
    expect(res.applied).toBe(true);
    expect(Number(res.onHand)).toBe(10);
    expect(Number(await svc.getOnHand(productId, siteAId, COMPANY))).toBe(10);

    const res2 = await svc.applyMovement({
      productId,
      siteId: siteAId,
      qtyDelta: -3,
      movementType: 'SALE',
      sourceSystem: 'test-p2',
      sourceKey: 'm2',
      contentHash: 'h2',
      companyId: COMPANY,
    });
    expect(Number(res2.onHand)).toBe(7);
  });

  it('keeps on-hand equal to the ledger sum after a randomised sequence', async () => {
    let expected = 0;
    for (let i = 0; i < 40; i++) {
      const delta = Math.floor(Math.random() * 101) - 50; // -50..50, integer
      expected += delta;
      await svc.applyMovement({
        productId,
        siteId: siteAId,
        qtyDelta: delta,
        movementType: delta >= 0 ? 'ADJUSTMENT' : 'SALE',
        sourceSystem: 'test-p2',
        sourceKey: `seq-${i}`,
        contentHash: `seq-h-${i}`,
        companyId: COMPANY,
      });
    }
    const cached = Number(await svc.getOnHand(productId, siteAId, COMPANY));
    const recomputed = Number(await svc.recomputeOnHand(productId, siteAId, COMPANY));
    expect(cached).toBe(expected);
    expect(recomputed).toBe(expected);
  });

  it('is idempotent on (source_system, source_key, content_hash)', async () => {
    const movement = {
      productId,
      siteId: siteAId,
      qtyDelta: 5,
      movementType: 'GRN' as const,
      sourceSystem: 'test-p2',
      sourceKey: 'dup',
      contentHash: 'dup-h',
      companyId: COMPANY,
    };
    const first = await svc.applyMovement(movement);
    const second = await svc.applyMovement(movement);

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(Number(second.onHand)).toBe(5); // unchanged

    const db = getDb();
    const rows = await db
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.sourceKey, 'dup')));
    expect(rows).toHaveLength(1); // exactly one ledger row
  });

  it('isolates sites — a movement at one site never affects another', async () => {
    await svc.applyMovement({
      productId,
      siteId: siteAId,
      qtyDelta: 12,
      movementType: 'GRN',
      sourceSystem: 'test-p2',
      sourceKey: 'iso-a',
      contentHash: 'iso-a-h',
      companyId: COMPANY,
    });
    expect(Number(await svc.getOnHand(productId, siteAId, COMPANY))).toBe(12);
    expect(Number(await svc.getOnHand(productId, siteBId, COMPANY))).toBe(0);

    await svc.applyMovement({
      productId,
      siteId: siteBId,
      qtyDelta: 4,
      movementType: 'GRN',
      sourceSystem: 'test-p2',
      sourceKey: 'iso-b',
      contentHash: 'iso-b-h',
      companyId: COMPANY,
    });
    expect(Number(await svc.getOnHand(productId, siteAId, COMPANY))).toBe(12); // untouched
    expect(Number(await svc.getOnHand(productId, siteBId, COMPANY))).toBe(4);
  });
});
