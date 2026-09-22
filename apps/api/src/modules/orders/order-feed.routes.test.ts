/**
 * The order feed, driven through the real app with a real API key:
 *   - a key with orders:write creates an order and gets its number back
 *   - the same reference again returns the same order, not a second one
 *   - an unknown product code is refused with 422 and creates nothing
 *   - a key without the scope gets 403; no key gets 401
 *   - orders:read returns the order's progress by reference; unknown → 404
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { apiKeys, customerDeliveryAddresses, customerOrders, customers, orderLines, products, warehouses } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

// API keys are issued under the singleton (the admin route reads it from the
// JWT middleware), so the orders land there too.
const COMPANY_ID = getSingletonCompanyId();
const EMAIL = 'feed-customer@example.invalid';

let app: FastifyInstance;
let writeKey: string;
let readKey: string;
let readOnlyKey: string;

async function issueKey(name: string, scopes: string[]): Promise<string> {
  const jwt = app.jwt.sign({ userId: 'operator', companyId: COMPANY_ID, email: 'op@example.com', roles: ['admin'] });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/api-keys',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name, scopes },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { data: { key: string } }).data.key;
}

async function cleanup() {
  const db = getDb();
  // Every order of the test customer goes, by customer rather than by
  // reference: a run that died between creating the order and writing its
  // reference would otherwise leave one behind that blocks the next run.
  const owned = await db.select({ id: customers.id }).from(customers).where(eq(customers.email, EMAIL));
  for (const c of owned) {
    const orders = await db.select({ id: customerOrders.id }).from(customerOrders).where(eq(customerOrders.customerId, c.id));
    for (const o of orders) await db.delete(orderLines).where(eq(orderLines.orderId, o.id));
    await db.delete(customerOrders).where(eq(customerOrders.customerId, c.id));
    await db.delete(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.customerId, c.id));
  }
  await db.delete(customers).where(eq(customers.email, EMAIL));
  await db.delete(products).where(eq(products.stockCode, 'FEED-SKU'));
  await db.delete(warehouses).where(eq(warehouses.name, 'Feed Test Warehouse'));
  await db.delete(apiKeys).where(eq(apiKeys.name, 'feed-write'));
  await db.delete(apiKeys).where(eq(apiKeys.name, 'feed-read'));
  await db.delete(apiKeys).where(eq(apiKeys.name, 'feed-read-only'));
}

const order = (reference: string, sku = 'FEED-SKU') => ({
  reference,
  orderDate: '2026-09-21',
  customer: { name: 'Feed Customer', email: EMAIL, phone: '07700 900000' },
  deliveryAddress: { contactName: 'Feed Customer', line1: '9 Feed Lane', city: 'Town', postCode: 'FE1 1ED', country: 'United Kingdom' },
  lines: [{ sku, quantity: 2, unitPrice: 12.5 }],
  deliveryCharge: 4,
  courierName: 'DPD',
  warehouseName: 'feed test warehouse',
  metadata: { channel: 'legacy-feed' },
});

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  await cleanup();
  const db = getDb();
  await db.insert(warehouses).values({ companyId: COMPANY_ID, name: 'Feed Test Warehouse' });
  await db.insert(products).values({ companyId: COMPANY_ID, name: 'Feed Widget', stockCode: 'FEED-SKU', productType: 'PHYSICAL' });
  writeKey = await issueKey('feed-write', ['orders:write']);
  readKey = await issueKey('feed-read', ['orders:read']);
  readOnlyKey = await issueKey('feed-read-only', ['storefront:read']);
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

describe('POST /order-feed/orders', () => {
  it('creates the order and returns its number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/order-feed/orders',
      headers: { authorization: `Bearer ${writeKey}` },
      payload: order('FEED-1'),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { success: boolean; duplicate: boolean; data: Record<string, string> };
    expect(body.success).toBe(true);
    expect(body.duplicate).toBe(false);
    expect(body.data.reference).toBe('FEED-1');
    expect(body.data.orderNumber).toMatch(/^SO-\d{6}$/);
    expect(body.data.status).toBe('CONFIRMED');

    const row = await getDb().query.customerOrders.findFirst({
      where: eq(customerOrders.id, body.data.orderId!),
      with: { warehouse: true, deliveryAddress: true },
    });
    expect(row?.sourceChannel).toBe('API');
    expect(row?.courierName).toBe('DPD');
    expect(row?.warehouse?.name).toBe('Feed Test Warehouse');
    expect(row?.deliveryAddress?.phone).toBe('07700 900000');
    expect(row?.integrationMetadata).toEqual({ channel: 'legacy-feed' });
  });

  it('returns the existing order for a repeated reference', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/order-feed/orders',
      headers: { authorization: `Bearer ${writeKey}` },
      payload: order('FEED-1'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, duplicate: true, data: { reference: 'FEED-1' } });
    const rows = await getDb().select().from(customerOrders).where(eq(customerOrders.thirdPartyOrderId, 'FEED-1'));
    expect(rows).toHaveLength(1);
  });

  it('refuses an unknown product code with 422 and creates nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/order-feed/orders',
      headers: { authorization: `Bearer ${writeKey}` },
      payload: order('FEED-2', 'NOT-A-SKU'),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ success: false, error: 'Unknown product code(s): NOT-A-SKU' });
    const rows = await getDb().select().from(customerOrders).where(eq(customerOrders.thirdPartyOrderId, 'FEED-2'));
    expect(rows).toHaveLength(0);
  });

  it('rejects a malformed body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/order-feed/orders',
      headers: { authorization: `Bearer ${writeKey}` },
      payload: { reference: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('needs the orders:write scope', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/order-feed/orders',
      headers: { authorization: `Bearer ${readOnlyKey}` },
      payload: order('FEED-2'),
    });
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'POST', url: '/api/v1/order-feed/orders', payload: order('FEED-2') });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('GET /order-feed/orders/:reference', () => {
  it("returns the order's progress", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/order-feed/orders/FEED-1',
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      reference: 'FEED-1',
      status: 'CONFIRMED',
      orderDate: '2026-09-21',
      courierName: 'DPD',
      trackingNumber: null,
      lines: [{ sku: 'FEED-SKU', quantity: 2, shipped: 0 }],
    });
  });

  it('is 404 for a reference never posted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/order-feed/orders/NEVER',
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('needs the orders:read scope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/order-feed/orders/FEED-1',
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
