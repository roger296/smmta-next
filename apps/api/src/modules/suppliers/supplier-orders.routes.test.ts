/**
 * Integration tests for the supplier-orders dashboard endpoints (§F).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { supplierOrders, suppliers } from '../../db/schema/index.js';
import { DropshipSupplierService } from './supplier-dropship.service.js';
import { resetCryptoForTests } from '../../shared/crypto/encrypt.js';

const COMPANY = '11111111-aaaa-4bbb-8ccc-111111111111';
const SLUG = 'so-routes-test';
let app: FastifyInstance;
let jwt: string;
let supplierId: string;
const service = new DropshipSupplierService();

async function wipe() {
  const db = getDb();
  await db.delete(supplierOrders).where(eq(supplierOrders.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.slug, SLUG));
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  process.env.ENCRYPTION_KEY = 'so-routes-test-encryption-key-some-entropy';
  resetCryptoForTests();
  await wipe();
  const db = getDb();
  const [s] = await db
    .insert(suppliers)
    .values({
      companyId: COMPANY, name: 'SO Test Supplier', slug: SLUG,
      connectorKind: 'STUB', apiBaseUrl: 'https://stub.invalid/',
      apiKeyEnc: service.encryptApiKey('k'), isDropshipActive: true,
    })
    .returning();
  supplierId = s!.id;
  app = await buildApp();
  await app.ready();
  jwt = app.jwt.sign({
    userId: 'op',
    companyId: COMPANY,
    email: 'op@test.invalid',
    roles: ['admin'],
  });
});

afterAll(async () => {
  if (app) await app.close();
  await wipe();
  await closeDatabase();
});

beforeEach(async () => {
  const db = getDb();
  await db.delete(supplierOrders).where(eq(supplierOrders.supplierId, supplierId));
});

async function insertSupplierOrder(status: 'PENDING' | 'PLACED' | 'FAILED', idempotencyKey: string) {
  const db = getDb();
  const [row] = await db
    .insert(supplierOrders)
    .values({
      companyId: COMPANY,
      customerOrderId: '00000000-0000-4000-8000-000000000001',
      supplierId,
      idempotencyKey,
      status,
      retryCount: status === 'FAILED' ? 5 : 0,
      errorMessage: status === 'FAILED' ? 'simulated failure' : null,
    })
    .returning();
  return row!;
}

describe('GET /api/v1/supplier-orders', () => {
  it('lists rows with status filter', async () => {
    await insertSupplierOrder('PENDING', 'idem-list-1');
    await insertSupplierOrder('FAILED', 'idem-list-2');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/supplier-orders?status=FAILED',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ status: string }> };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((r) => r.status === 'FAILED')).toBe(true);
  });

  it('rejects without a JWT', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/supplier-orders' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/v1/supplier-orders/:id/retry', () => {
  it('resets a FAILED row to PENDING + retryCount 0', async () => {
    const r = await insertSupplierOrder('FAILED', 'idem-retry-1');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/supplier-orders/${r.id}/retry`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const db = getDb();
    const updated = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, r.id) });
    expect(updated!.status).toBe('PENDING');
    expect(updated!.retryCount).toBe(0);
    expect(updated!.errorMessage).toBeNull();
    expect(updated!.nextRetryAt).toBeNull();
  });

  it('409s on a non-FAILED row', async () => {
    const r = await insertSupplierOrder('PLACED', 'idem-retry-2');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/supplier-orders/${r.id}/retry`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/v1/supplier-orders/:id/cancel', () => {
  it('cancels a PENDING row', async () => {
    const r = await insertSupplierOrder('PENDING', 'idem-cancel-1');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/supplier-orders/${r.id}/cancel`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const db = getDb();
    const updated = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, r.id) });
    expect(updated!.status).toBe('CANCELLED');
  });

  it('409s on a non-PENDING row', async () => {
    const r = await insertSupplierOrder('PLACED', 'idem-cancel-2');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/supplier-orders/${r.id}/cancel`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/v1/supplier-orders/:id/mark-shipped', () => {
  it('flips to SHIPPED + records tracking', async () => {
    const r = await insertSupplierOrder('PLACED', 'idem-ship-1');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/supplier-orders/${r.id}/mark-shipped`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { trackingCarrier: 'Royal Mail', trackingNumber: 'RM12345' },
    });
    expect(res.statusCode).toBe(200);
    const db = getDb();
    const updated = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, r.id) });
    expect(updated!.status).toBe('SHIPPED');
    expect(updated!.trackingCarrier).toBe('Royal Mail');
    expect(updated!.trackingNumber).toBe('RM12345');
    expect(updated!.shippedAt).toBeTruthy();
  });
});

describe('GET /api/v1/supplier-orders/:id', () => {
  it('returns the row with the supplier joined', async () => {
    const r = await insertSupplierOrder('PENDING', 'idem-detail-1');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/supplier-orders/${r.id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { id: string; supplier: { id: string } } };
    expect(body.data.id).toBe(r.id);
    expect(body.data.supplier.id).toBe(supplierId);
  });
});
