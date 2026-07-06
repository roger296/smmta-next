/**
 * Storefront pools endpoint test (PDP data). Mints a storefront:read api-key via
 * the admin route, then asserts the customer-facing shape (£ savings, no
 * internal fields).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, like } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { products, pricingRules, inboundShipments, inboundShipmentLines } from '../../db/schema/index.js';

const COMPANY = getSingletonCompanyId();
const NOW = Date.parse('2026-07-04T00:00:00Z');
const DAY = 86_400_000;
const SKU = 'POOLS-PLA';
let app: FastifyInstance;
let key: string;

beforeAll(async () => {
  const db = getDb();
  await db
    .insert(pricingRules)
    .values({ companyId: COMPANY, category: null, preorderBands: [{ minDaysToEta: 60, discountBp: 2000 }, { minDaysToEta: 0, discountBp: 500 }] })
    .onConflictDoNothing();
  await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Pools PLA', stockCode: SKU, minSellingPrice: '20.00' })
    .onConflictDoNothing();
  const eta = new Date(Date.now() + 70 * DAY);
  const [ship] = await db
    .insert(inboundShipments)
    .values({ companyId: COMPANY, reference: 'POOLS-70', etaOriginal: eta, eta, status: 'in_transit', bufferPct: 0 })
    .returning({ id: inboundShipments.id });
  await db.insert(inboundShipmentLines).values({ companyId: COMPANY, shipmentId: ship!.id, sku: SKU, qtyManifested: 100 });

  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  const jwt = app.jwt.sign({ userId: 'op', companyId: COMPANY, email: 'op@example.com', roles: ['admin'] });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/api-keys',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name: `pools-test-${Date.now()}`, scopes: ['storefront:read'] },
  });
  key = (res.json() as { data: { key: string } }).data.key;
});

afterAll(async () => {
  const db = getDb();
  await db.delete(inboundShipmentLines).where(eq(inboundShipmentLines.sku, SKU));
  await db.delete(inboundShipments).where(like(inboundShipments.reference, 'POOLS-%'));
  await db.delete(products).where(and(eq(products.companyId, COMPANY), eq(products.stockCode, SKU)));
  await app.close();
  await closeDatabase();
});

describe('GET /storefront/skus/:sku/pools', () => {
  it('returns the warehouse band + inbound pools with £ savings, no internal fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/storefront/skus/${SKU}/pools`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { warehouse: { band: string; pricePence: number }; inbound: Array<{ shipmentRef: string; savingsVsBasePence: number; unitPricePence: number }> } };
    expect(body.data.warehouse.band).toBe('out_of_stock');
    expect(body.data.warehouse.pricePence).toBe(2000); // £20.00
    expect(body.data.inbound).toHaveLength(1);
    // 70-day band 20% → save £4.00 → £16.00.
    expect(body.data.inbound[0]!.savingsVsBasePence).toBe(400);
    expect(body.data.inbound[0]!.unitPricePence).toBe(1600);
    // no internal fields leaked
    expect(JSON.stringify(body)).not.toMatch(/Internal/);
  });

  it('rejects a request without the storefront:read key', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/storefront/skus/${SKU}/pools` });
    expect(res.statusCode).toBe(401);
  });
});
