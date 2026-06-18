/**
 * Square sales → stock decrement (P10, spec §A8). Real Postgres, isolated.
 *
 * Covers: a sale decrements the mapped SKU at the mapped site; replaying the
 * same line is a no-op; an unmapped item is quarantined (not dropped); a sale
 * crossing the reorder point raises a replenishment (via the decrement hook).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  products,
  reorderProposals,
  sites,
  squareItemMap,
  squareUnmappedLines,
  stockLevels,
  stockMovements,
} from '../../db/schema/index.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { SquareDecrementService } from './square-decrement.service.js';

const COMPANY = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const svc = new SquareDecrementService();
const levels = new StockLevelService();
let siteId: string;
let cookieId: string;

async function clear(): Promise<void> {
  const db = getDb();
  await db.delete(reorderProposals).where(eq(reorderProposals.companyId, COMPANY));
  await db.delete(squareUnmappedLines).where(eq(squareUnmappedLines.companyId, COMPANY));
  await db.delete(squareItemMap).where(eq(squareItemMap.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  const [c] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Sq Cookie', slug: 'sq-cookie', itemKind: 'RETAIL', stockUom: 'each', barcode: '5060000000001' })
    .returning();
  cookieId = c!.id;
  const [s] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'sq-site', name: 'Sq Site', canonicalName: 'London East' })
    .returning();
  siteId = s!.id;
});

beforeEach(clear);

afterAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

describe('ingestLine', () => {
  it('decrements the mapped SKU at the mapped site, and replays are no-ops', async () => {
    await svc.upsertMap([{ squareKey: 'SQ-COOKIE', productId: cookieId }], COMPANY);
    await levels.applyMovement({
      productId: cookieId, siteId, qtyDelta: 20, movementType: 'OPENING',
      sourceSystem: 'seed', sourceKey: 'open', contentHash: 'o', companyId: COMPANY,
    });

    const first = await svc.ingestLine({
      channelSlug: 'square', sourcePk: 'ORD1', sourceLineRef: 'L1', qty: 3,
      squareKey: 'SQ-COOKIE', siteCanonical: 'London East', companyId: COMPANY,
    });
    expect(first.status).toBe('applied');
    expect(Number(await levels.getOnHand(cookieId, siteId, COMPANY))).toBe(17);

    const replay = await svc.ingestLine({
      channelSlug: 'square', sourcePk: 'ORD1', sourceLineRef: 'L1', qty: 3,
      squareKey: 'SQ-COOKIE', siteCanonical: 'London East', companyId: COMPANY,
    });
    expect(replay.status).toBe('duplicate');
    expect(Number(await levels.getOnHand(cookieId, siteId, COMPANY))).toBe(17); // unchanged
  });

  it('quarantines an unmapped item instead of dropping it', async () => {
    const res = await svc.ingestLine({
      channelSlug: 'square', sourcePk: 'ORD2', sourceLineRef: 'L1', qty: 1,
      squareKey: 'SQ-UNKNOWN', siteCanonical: 'London East', companyId: COMPANY,
    });
    expect(res.status).toBe('quarantined');
    expect(res.reason).toBe('unmapped_item');
    const unmapped = await svc.listUnmapped(COMPANY);
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]!.squareKey).toBe('SQ-UNKNOWN');
  });

  it('raises a replenishment when a sale crosses the reorder point', async () => {
    await svc.upsertMap([{ squareKey: 'SQ-COOKIE', productId: cookieId }], COMPANY);
    await getDb().insert(stockLevels).values({
      companyId: COMPANY, productId: cookieId, siteId, onHand: '12', reorderPoint: '10', reorderUpTo: '50',
    });
    await svc.ingestLine({
      channelSlug: 'square', sourcePk: 'ORD3', sourceLineRef: 'L1', qty: 5,
      squareKey: 'SQ-COOKIE', siteId, companyId: COMPANY,
    });
    // on-hand 7 ≤ 10 → the decrement hook raised a proposal.
    const proposals = await getDb()
      .select({ id: reorderProposals.id })
      .from(reorderProposals)
      .where(eq(reorderProposals.productId, cookieId));
    expect(proposals).toHaveLength(1);
  });
});

describe('autoMatchByBarcode', () => {
  it('matches a Square key to a product by barcode', async () => {
    const matched = await svc.autoMatchByBarcode(
      [{ squareKey: 'SQ-AUTO', code: '5060000000001' }],
      COMPANY,
    );
    expect(matched).toBe(1);
    const map = await svc.listMap(COMPANY);
    expect(map.find((m) => m.squareKey === 'SQ-AUTO')?.productId).toBe(cookieId);
  });
});
