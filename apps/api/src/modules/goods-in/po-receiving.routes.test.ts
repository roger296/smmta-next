/**
 * Booking against a purchase order, through the HTTP routes (Sept 2026).
 * Real Postgres + the built app, singleton company.
 *
 * Covers: an order is raised for a venue; a venue PIN sees its own expected
 * orders and not another venue's; an over-delivery comes back as 409 with the
 * lines, so a screen can ask; accepted, it books; the retired book-in says
 * where booking went.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  goodsInReceiptLines,
  goodsInReceipts,
  products,
  purchaseOrderLines,
  purchaseOrders,
  sites,
  stockLevels,
  stockMovements,
  suppliers,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

const COMPANY = getSingletonCompanyId();
let app: FastifyInstance;
let admin: string;
let eastPin: string;
let southPin: string;
let east: string;
let south: string;
let supplierId: string;
let flour: string;
let poId: string;
let flourLine: string;

async function cleanup(): Promise<void> {
  const db = getDb();
  const siteRows = await db.select({ id: sites.id }).from(sites).where(inArray(sites.slug, ['porr-east', 'porr-south']));
  const siteIds = siteRows.map((s) => s.id);
  if (siteIds.length) {
    const receipts = await db.select({ id: goodsInReceipts.id }).from(goodsInReceipts).where(inArray(goodsInReceipts.siteId, siteIds));
    if (receipts.length) await db.delete(goodsInReceiptLines).where(inArray(goodsInReceiptLines.receiptId, receipts.map((r) => r.id)));
    await db.delete(goodsInReceipts).where(inArray(goodsInReceipts.siteId, siteIds));
    await db.delete(stockMovements).where(inArray(stockMovements.siteId, siteIds));
    await db.delete(stockLevels).where(inArray(stockLevels.siteId, siteIds));
  }
  const sup = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, 'PORR Supplier'));
  if (sup.length) {
    const orders = await db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.supplierId, sup[0]!.id));
    if (orders.length) {
      await db.delete(purchaseOrderLines).where(inArray(purchaseOrderLines.purchaseOrderId, orders.map((o) => o.id)));
      await db.delete(purchaseOrders).where(inArray(purchaseOrders.id, orders.map((o) => o.id)));
    }
    await db.delete(suppliers).where(eq(suppliers.id, sup[0]!.id));
  }
  await db.delete(products).where(eq(products.slug, 'porr-flour'));
  if (siteIds.length) await db.delete(sites).where(inArray(sites.id, siteIds));
}

const call = (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as object });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  await cleanup();
  const db = getDb();
  east = (await db.insert(sites).values({ companyId: COMPANY, slug: 'porr-east', name: 'PORR East', canonicalName: 'PORR East' }).returning())[0]!.id;
  south = (await db.insert(sites).values({ companyId: COMPANY, slug: 'porr-south', name: 'PORR South', canonicalName: 'PORR South' }).returning())[0]!.id;
  supplierId = (await db.insert(suppliers).values({ companyId: COMPANY, name: 'PORR Supplier' }).returning())[0]!.id;
  flour = (
    await db
      .insert(products)
      .values({ companyId: COMPANY, name: 'PORR Flour', slug: 'porr-flour', itemKind: 'INGREDIENT', stockUom: 'g', purchaseUom: 'sack', purchaseToStockFactor: '16000' })
      .returning()
  )[0]!.id;

  admin = app.jwt.sign({ userId: 'porr-admin', companyId: COMPANY, email: 'a@porr.invalid', roles: ['admin'] });
  const pin = (siteId: string) =>
    app.jwt.sign({ userId: `pin:${siteId}`, companyId: COMPANY, email: 'p@pin.local', roles: ['head_baker'], siteId, siteIds: [siteId], label: 'Sam' });
  eastPin = pin(east);
  southPin = pin(south);
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

describe('booking against an order over HTTP', () => {
  it('head office raises an order for a venue', async () => {
    const res = await call('POST', '/purchase-orders', admin, {
      supplierId,
      siteId: east,
      lines: [{ productId: flour, quantity: 10, pricePerUnit: 18, taxRate: 0 }],
    });
    expect(res.statusCode).toBe(201);
    poId = res.json().data.id;
    expect(res.json().data.siteId).toBe(east);
    flourLine = res.json().data.lines[0].id;
  });

  it("a venue sees its own expected orders, and not another venue's", async () => {
    const mine = await call('GET', `/goods-in/expected?siteId=${east}`, eastPin);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data.map((o: { id: string }) => o.id)).toEqual([poId]);

    expect((await call('GET', `/goods-in/expected?siteId=${south}`, southPin)).json().data).toEqual([]);
    expect((await call('GET', `/goods-in/expected?siteId=${east}`, southPin)).statusCode).toBe(403);
    expect((await call('GET', `/purchase-orders/${poId}/receiving`, southPin)).statusCode).toBe(403);
  });

  it('an over-delivery comes back as 409 with the lines, so the screen can ask', async () => {
    const res = await call('POST', '/goods-in', eastPin, {
      siteId: east,
      purchaseOrderId: poId,
      idempotencyKey: `porr-${Date.now()}-a`,
      lines: [{ productId: flour, qtyPurchase: 12, purchaseOrderLineId: flourLine }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      success: false,
      code: 'OVER_DELIVERY',
      overDelivery: [{ productName: 'PORR Flour', ordered: 10, receivingNow: 12, over: 2 }],
    });
  });

  it('accepted, it books, and the order shows it', async () => {
    const res = await call('POST', '/goods-in', eastPin, {
      siteId: east,
      purchaseOrderId: poId,
      deliveryNoteNumber: 'BR-55012',
      acceptOverDelivery: true,
      idempotencyKey: `porr-${Date.now()}-b`,
      lines: [{ productId: flour, qtyPurchase: 12, purchaseOrderLineId: flourLine }],
    });
    expect(res.statusCode).toBe(201);
    const view = (await call('GET', `/purchase-orders/${poId}/receiving`, admin)).json().data;
    expect(view).toMatchObject({ deliveryStatus: 'FULLY_RECEIVED', receipts: [{ deliveryNoteNumber: 'BR-55012', variance: 'OVER' }] });
    expect(view.lines[0]).toMatchObject({ ordered: 10, received: 12, outstanding: 0 });
  });

  it('a venue cannot book into another venue with an order that is not theirs', async () => {
    const res = await call('POST', '/goods-in', southPin, {
      siteId: south,
      purchaseOrderId: poId,
      acceptOverDelivery: true,
      idempotencyKey: `porr-${Date.now()}-c`,
      lines: [{ productId: flour, qtyPurchase: 1, purchaseOrderLineId: flourLine }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/is for PORR East/);
  });

  it('the retired book-in says where booking went', async () => {
    const res = await call('POST', `/purchase-orders/${poId}/book-in`, admin, { lines: [] });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toMatch(/POST \/api\/v1\/goods-in with purchaseOrderId/);
  });
});
