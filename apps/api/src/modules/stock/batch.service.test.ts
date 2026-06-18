/**
 * Batch & use-by tracking (P21, spec §A3, §9). Real Postgres, isolated company.
 *
 * Covers: FEFO decrement consumes the earliest use-by first; an expired batch is
 * flagged; non-batch items are unaffected; goods-in assigns a batch correctly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  glPostingLog,
  goodsInReceiptLines,
  goodsInReceipts,
  products,
  sites,
  stockBatches,
  stockLevels,
  stockMovements,
} from '../../db/schema/index.js';
import { BatchService } from './batch.service.js';
import { GoodsInService } from '../goods-in/goods-in.service.js';

const COMPANY = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const batches = new BatchService();
const goodsIn = new GoodsInService();

let siteId: string;
let milkId: string; // batch-tracked
let flourId: string; // not batch-tracked

async function clear(): Promise<void> {
  const db = getDb();
  const receipts = await db.select({ id: goodsInReceipts.id }).from(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  for (const r of receipts) await db.delete(goodsInReceiptLines).where(eq(goodsInReceiptLines.receiptId, r.id));
  await db.delete(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  await db.delete(stockBatches).where(eq(stockBatches.companyId, COMPANY));
  await db.delete(glPostingLog).where(eq(glPostingLog.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  const [m] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'B Milk', slug: 'b-milk', itemKind: 'INGREDIENT', stockUom: 'ml', purchaseUom: 'L', purchaseToStockFactor: '1000', requireBatchNumber: true, expectedNextCost: '0.001' })
    .returning();
  milkId = m!.id;
  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'B Flour', slug: 'b-flour', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.05' })
    .returning();
  flourId = f!.id;
  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'b-site', name: 'B Site', canonicalName: 'B Site' })
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

describe('FEFO decrement', () => {
  it('consumes the earliest use-by first', async () => {
    await batches.receive({ productId: milkId, siteId, batchCode: 'LATE', qty: 10, useBy: '2026-06-25', companyId: COMPANY });
    await batches.receive({ productId: milkId, siteId, batchCode: 'EARLY', qty: 10, useBy: '2026-06-20', companyId: COMPANY });

    const alloc = await batches.decrementFEFO({ productId: milkId, siteId, qty: 15, companyId: COMPANY });
    // Earliest use-by (EARLY, 06-20) first, then LATE for the remainder.
    expect(alloc.map((a) => a.batchCode)).toEqual(['EARLY', 'LATE']);
    expect(alloc[0]!.qty).toBe(10);
    expect(alloc[1]!.qty).toBe(5);

    const early = await getDb().query.stockBatches.findFirst({ where: eq(stockBatches.batchCode, 'EARLY') });
    const late = await getDb().query.stockBatches.findFirst({ where: eq(stockBatches.batchCode, 'LATE') });
    expect(Number(early!.qtyRemaining)).toBe(0);
    expect(Number(late!.qtyRemaining)).toBe(5);
  });
});

describe('expiry', () => {
  it('flags an expired batch and lists soon-to-expire lots', async () => {
    await batches.receive({ productId: milkId, siteId, batchCode: 'OLD', qty: 5, useBy: '2026-06-01', companyId: COMPANY });
    await batches.receive({ productId: milkId, siteId, batchCode: 'SOON', qty: 5, useBy: '2026-06-20', companyId: COMPANY });
    await batches.receive({ productId: milkId, siteId, batchCode: 'FAR', qty: 5, useBy: '2026-09-01', companyId: COMPANY });

    const expired = await batches.expired({ asOf: '2026-06-18', companyId: COMPANY });
    expect(expired.map((b) => b.batchCode)).toEqual(['OLD']);

    const soon = await batches.expiringSoon({ asOf: '2026-06-18', withinDays: 7, companyId: COMPANY });
    expect(soon.map((b) => b.batchCode)).toEqual(['SOON']); // FAR is > 7 days out
  });
});

describe('goods-in', () => {
  it('assigns a batch for a batch-tracked product on receipt', async () => {
    await goodsIn.receive({
      siteId,
      idempotencyKey: 'b-grn-milk',
      lines: [{ productId: milkId, qtyPurchase: 2, unitCost: 1, batchCode: 'M-001', useBy: '2026-06-22' }],
      companyId: COMPANY,
    });
    const batch = await getDb().query.stockBatches.findFirst({ where: eq(stockBatches.batchCode, 'M-001') });
    expect(batch).toBeTruthy();
    expect(Number(batch!.qtyRemaining)).toBe(2000); // 2 L × 1000
    expect(batch!.useBy).toBe('2026-06-22');
  });

  it('does not create a batch for a non-batch-tracked product', async () => {
    await goodsIn.receive({
      siteId,
      idempotencyKey: 'b-grn-flour',
      lines: [{ productId: flourId, qtyPurchase: 5, unitCost: 0.05 }],
      companyId: COMPANY,
    });
    const rows = await getDb().select({ id: stockBatches.id }).from(stockBatches).where(eq(stockBatches.productId, flourId));
    expect(rows).toHaveLength(0);
  });
});
