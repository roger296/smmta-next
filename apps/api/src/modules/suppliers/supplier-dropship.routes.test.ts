/**
 * Integration tests for the drop-ship supplier admin routes.
 *
 * Covers happy paths + auth gating. The full poll-now flow is exercised
 * by `supplier-poll.worker.test.ts`; here we just confirm the endpoint
 * responds and the worker is wired in correctly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { suppliers, supplierProducts, supplierPollLog, productGroups, products } from '../../db/schema/index.js';
import { DropshipSupplierService } from './supplier-dropship.service.js';
import {
  registerStubConnectorForTests,
  resetRegistryCacheForTests,
} from '../../integrations/suppliers/registry.js';
import { resetCryptoForTests } from '../../shared/crypto/encrypt.js';
import type { SupplierConnector } from '../../integrations/suppliers/types.js';

const COMPANY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SLUG = 'route-test-supplier';
const service = new DropshipSupplierService();
let app: FastifyInstance;
let jwt: string;
let supplierId: string;
let productId: string;

const stub: SupplierConnector = {
  async getStockAndPrice(skus) {
    return skus.map((sku) => ({ supplierSku: sku, stockQty: 7, costGbp: 1.5 }));
  },
  async placeOrder() { return { orderRef: 'X', status: 'ACCEPTED' }; },
  async getOrderStatus() { return { orderRef: 'X', status: 'PLACED' }; },
  async cancelOrder() { return { ok: true }; },
};

async function wipe() {
  const db = getDb();
  // Delete in dependency order: poll_log first (FK to suppliers),
  // mapping rows next (FK to suppliers + products), then products /
  // groups, then the supplier itself.
  const supplierRows = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.slug, SLUG));
  for (const s of supplierRows) {
    await db.delete(supplierPollLog).where(eq(supplierPollLog.supplierId, s.id));
  }
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  for (const p of ps) {
    await db.delete(products).where(eq(products.id, p.id));
  }
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.slug, SLUG));
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  process.env.ENCRYPTION_KEY = 'route-test-encryption-key-some-entropy';
  resetCryptoForTests();
  resetRegistryCacheForTests();

  await wipe();
  const db = getDb();

  const [g] = await db
    .insert(productGroups)
    .values({ companyId: COMPANY, name: 'Route Test Group', slug: 'route-test-group' })
    .returning();
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Route Test Product', slug: 'route-test-product', groupId: g!.id, minSellingPrice: '10.00' })
    .returning();
  productId = p!.id;

  const [s] = await db
    .insert(suppliers)
    .values({
      companyId: COMPANY,
      name: 'Route Test Supplier',
      slug: SLUG,
      connectorKind: 'STUB',
      apiBaseUrl: 'https://stub.invalid/',
      apiKeyEnc: service.encryptApiKey('stub-key'),
      apiAuthScheme: 'bearer',
      isDropshipActive: true,
    })
    .returning();
  supplierId = s!.id;
  registerStubConnectorForTests(supplierId, stub);

  app = await buildApp();
  await app.ready();
  jwt = app.jwt.sign({
    userId: 'test-op',
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
  // Reset supplier flags between tests
  const db = getDb();
  await db
    .update(suppliers)
    .set({ isDropshipActive: true, lastError: null, consecutiveFailures: 0 })
    .where(eq(suppliers.id, supplierId));
  await db.delete(supplierProducts).where(eq(supplierProducts.productId, productId));
});

describe('GET /api/v1/suppliers-dropship', () => {
  it('returns the suppliers list, with hasApiKey flag, no apiKeyEnc', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/suppliers-dropship',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: Array<Record<string, unknown>> };
    const ours = body.data.find((r) => r.slug === SLUG);
    expect(ours).toBeDefined();
    expect(ours!.hasApiKey).toBe(true);
    expect(ours!.apiKeyEnc).toBeUndefined();
  });

  it('rejects without a JWT', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/suppliers-dropship' });
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /api/v1/suppliers-dropship/:id', () => {
  it('updates fields without overwriting the api key when plaintext is omitted', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/suppliers-dropship/${supplierId}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { pollIntervalMinutes: 15 },
    });
    expect(res.statusCode).toBe(200);
    const db = getDb();
    const row = await db.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) });
    expect(row!.pollIntervalMinutes).toBe(15);
    expect(row!.apiKeyEnc).toBeTruthy();
  });

  it('encrypts apiKeyPlaintext when supplied', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/suppliers-dropship/${supplierId}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { apiKeyPlaintext: 'rotated-key-value' },
    });
    expect(res.statusCode).toBe(200);
    const db = getDb();
    const row = await db.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) });
    const { decrypt } = await import('../../shared/crypto/encrypt.js');
    expect(decrypt(row!.apiKeyEnc!)).toBe('rotated-key-value');
  });
});

describe('POST /api/v1/suppliers-dropship/:id/test', () => {
  it('returns ok=true with snapshot data when the connector works', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/suppliers-dropship/${supplierId}/test`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { supplierSku: 'TEST-SKU' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { ok: boolean; snapshots?: Array<{ supplierSku: string }> } };
    expect(body.data.ok).toBe(true);
    expect(body.data.snapshots![0]!.supplierSku).toBe('TEST-SKU');
  });
});

describe('POST /api/v1/suppliers-dropship/:id/poll-now', () => {
  it('runs the worker for a single supplier (skips cadence)', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY,
      productId,
      supplierId,
      supplierSku: 'A',
      costGbp: '1.00',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/suppliers-dropship/${supplierId}/poll-now`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ supplierId: string; productsUpdated: number }> };
    expect(body.data[0]!.supplierId).toBe(supplierId);
    expect(body.data[0]!.productsUpdated).toBe(1);
  });
});

describe('GET / PUT /api/v1/products/:id/supplier-mappings', () => {
  it('upserts mappings, then returns them', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${productId}/supplier-mappings`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        mappings: [
          { supplierId, supplierSku: 'PROD-SKU-1', costGbp: '3.50', priority: 50, isActive: true },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${productId}/supplier-mappings`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(get.statusCode).toBe(200);
    const body = get.json() as { data: Array<{ supplierSku: string; priority: number }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.supplierSku).toBe('PROD-SKU-1');
    expect(body.data[0]!.priority).toBe(50);
  });

  it('soft-deletes mappings absent from a subsequent PUT', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${productId}/supplier-mappings`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        mappings: [
          { supplierId, supplierSku: 'WILL-BE-DELETED', costGbp: '1.00', priority: 100, isActive: true },
        ],
      },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${productId}/supplier-mappings`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { mappings: [] },
    });
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${productId}/supplier-mappings`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const body = get.json() as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });
});

describe('GET /api/v1/health/supplier-poll', () => {
  it('reports per-supplier status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health/supplier-poll',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ supplierId: string; status: string }> };
    const ours = body.data.find((r) => r.supplierId === supplierId);
    expect(ours).toBeDefined();
    expect(['ok', 'stale', 'failing', 'never-polled']).toContain(ours!.status);
  });
});
