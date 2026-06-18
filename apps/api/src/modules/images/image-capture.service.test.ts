/**
 * AI groundwork — image captures + stub MCP tools (P23, spec §A10). Real Postgres.
 *
 * Covers: captured images are retrievable by SKU/site/timestamp; the stub MCP
 * tools return the not-enabled response (with the stored reference) without
 * error; image storage doesn't block the goods-in capturing workflow.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  glPostingLog,
  goodsInReceiptLines,
  goodsInReceipts,
  imageCaptures,
  products,
  sites,
  stockLevels,
  stockMovements,
} from '../../db/schema/index.js';
import { ImageCaptureService } from './image-capture.service.js';
import { GoodsInService } from '../goods-in/goods-in.service.js';
import { getMcpTool } from '../mcp/tools.js';

const COMPANY = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
const images = new ImageCaptureService();
const goodsIn = new GoodsInService();

let siteId: string;
let productId: string;

async function clear(): Promise<void> {
  const db = getDb();
  await db.delete(imageCaptures).where(eq(imageCaptures.companyId, COMPANY));
  const receipts = await db.select({ id: goodsInReceipts.id }).from(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  for (const r of receipts) await db.delete(goodsInReceiptLines).where(eq(goodsInReceiptLines.receiptId, r.id));
  await db.delete(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  await db.delete(glPostingLog).where(eq(glPostingLog.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'I Flour', slug: 'i-flour', stockCode: 'SKU-1', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.05' })
    .returning();
  productId = p!.id;
  const [s] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'i-site', name: 'I Site', canonicalName: 'I Site' })
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

describe('image set', () => {
  it('captures are retrievable by SKU + site + timestamp', async () => {
    await images.record({
      productId, siteId, source: 'REFERENCE', imageRef: 'http://img/ref.jpg',
      capturedAt: new Date('2026-06-18T09:00:00Z'), companyId: COMPANY,
    });
    const forSku = await images.listForSku({ productId, siteId, companyId: COMPANY });
    expect(forSku).toHaveLength(1);
    expect(forSku[0]!.imageRef).toBe('http://img/ref.jpg');
    expect(forSku[0]!.capturedAt.toISOString()).toBe('2026-06-18T09:00:00.000Z');
  });

  it('recordPhotoRefs resolves a sku to a product', async () => {
    const n = await images.recordPhotoRefs({
      photoRefs: [{ url: 'http://img/a.jpg', sku: 'SKU-1' }],
      siteId, source: 'STOCK_TAKE', companyId: COMPANY,
    });
    expect(n).toBe(1);
    const forSku = await images.listForSku({ productId, companyId: COMPANY });
    expect(forSku[0]!.productId).toBe(productId);
  });
});

describe('stub MCP tools', () => {
  it('return the not-enabled response with the stored reference, no error', async () => {
    await images.record({ productId, siteId, source: 'REFERENCE', imageRef: 'http://img/x.jpg', companyId: COMPANY });

    const identify = getMcpTool('identify_item_from_image')!;
    const r1 = (await identify.handler({ image_ref: 'http://img/x.jpg' }, { companyId: COMPANY })) as {
      available: boolean; reference: { imageRef: string } | null;
    };
    expect(r1.available).toBe(false);
    expect(r1.reference?.imageRef).toBe('http://img/x.jpg');

    const count = getMcpTool('count_shelf_from_image')!;
    const r2 = (await count.handler({ image_ref: 'missing' }, { companyId: COMPANY })) as { available: boolean; reference: unknown };
    expect(r2.available).toBe(false);
    expect(r2.reference).toBeNull(); // unknown ref → no stored reference, still no error
  });
});

describe('capture does not block goods-in', () => {
  it('books in and records valid photos, ignoring malformed ones', async () => {
    const res = await goodsIn.receive({
      siteId,
      idempotencyKey: 'i-grn-1',
      lines: [{ productId, qtyPurchase: 10, unitCost: 0.05 }],
      photoRefs: [{ url: 'http://img/grn.jpg', sku: 'SKU-1' }, { sku: 'SKU-1' } as { url?: string }],
      companyId: COMPANY,
    });
    expect(res.receipt.id).toBeTruthy(); // goods-in succeeded
    const captures = await images.gallery({ source: 'GOODS_IN', companyId: COMPANY });
    expect(captures).toHaveLength(1); // only the valid photo recorded
    expect(captures[0]!.sourceRef).toBe(res.receipt.id);
  });
});
