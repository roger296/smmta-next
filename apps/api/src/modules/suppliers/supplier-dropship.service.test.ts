/**
 * Integration test for `DropshipSupplierService`.
 *
 * Hits a real Postgres at DATABASE_URL — same pattern as other integration
 * tests in this repo. Inserts a throwaway supplier row and exercises the
 * service via a stub connector wired up through `registerStubConnectorForTests`.
 *
 * The stub also lets us assert "the connector was called with this argument"
 * without needing a mock library — the stub records its own calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { suppliers } from '../../db/schema/index.js';
import { DropshipSupplierService } from './supplier-dropship.service.js';
import {
  registerStubConnectorForTests,
  resetRegistryCacheForTests,
} from '../../integrations/suppliers/registry.js';
import { resetCryptoForTests } from '../../shared/crypto/encrypt.js';
import type {
  SupplierConnector,
  SupplierOrderRequest,
} from '../../integrations/suppliers/types.js';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SLUG = 'stub-supplier-test';

class StubConnector implements SupplierConnector {
  public stockCalls: string[][] = [];
  public orderCalls: SupplierOrderRequest[] = [];
  public statusCalls: string[] = [];
  public cancelCalls: string[] = [];

  async getStockAndPrice(supplierSkus: string[]) {
    this.stockCalls.push(supplierSkus);
    return supplierSkus.map((sku) => ({
      supplierSku: sku,
      stockQty: 10,
      costGbp: 4.99,
    }));
  }
  async placeOrder(req: SupplierOrderRequest) {
    this.orderCalls.push(req);
    return { orderRef: 'STUB-ORDER-1', status: 'ACCEPTED' as const };
  }
  async getOrderStatus(orderRef: string) {
    this.statusCalls.push(orderRef);
    return { orderRef, status: 'PLACED' };
  }
  async cancelOrder(orderRef: string) {
    this.cancelCalls.push(orderRef);
    return { ok: true };
  }
}

let supplierId: string;
const service = new DropshipSupplierService();
const stub = new StubConnector();

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'service-test-encryption-key-with-some-entropy';
  resetCryptoForTests();
  resetRegistryCacheForTests();

  const db = getDb();
  await db.delete(suppliers).where(eq(suppliers.slug, SLUG));
  const [row] = await db
    .insert(suppliers)
    .values({
      companyId: COMPANY,
      name: 'Stub Supplier',
      slug: SLUG,
      connectorKind: 'STUB',
      apiBaseUrl: 'https://stub.invalid/',
      apiKeyEnc: service.encryptApiKey('stub-key'),
      apiAuthScheme: 'bearer',
      isDropshipActive: true,
    })
    .returning();
  if (!row) throw new Error('failed to insert stub supplier');
  supplierId = row.id;
  registerStubConnectorForTests(supplierId, stub);
});

afterAll(async () => {
  const db = getDb();
  await db.delete(suppliers).where(eq(suppliers.slug, SLUG));
  await closeDatabase();
});

beforeEach(() => {
  stub.stockCalls.length = 0;
  stub.orderCalls.length = 0;
  stub.statusCalls.length = 0;
  stub.cancelCalls.length = 0;
});

describe('DropshipSupplierService — dispatch via registry', () => {
  it('getStockAndPrice forwards SKUs and returns connector snapshots', async () => {
    const r = await service.getStockAndPrice(supplierId, ['A', 'B']);
    expect(r).toHaveLength(2);
    expect(r[0]!.supplierSku).toBe('A');
    expect(stub.stockCalls).toEqual([['A', 'B']]);
  });

  it('placeOrder forwards the request shape', async () => {
    const req: SupplierOrderRequest = {
      idempotencyKey: 'k1',
      customerOrderRef: 'ORD-1',
      shipping: {
        name: 'Pat',
        line1: '1 Test St',
        city: 'London',
        postCode: 'SW1A 1AA',
        country: 'GB',
      },
      lines: [{ supplierSku: 'A', qty: 1 }],
    };
    const r = await service.placeOrder(supplierId, req);
    expect(r.status).toBe('ACCEPTED');
    expect(stub.orderCalls).toHaveLength(1);
    expect(stub.orderCalls[0]!.idempotencyKey).toBe('k1');
  });

  it('getOrderStatus and cancelOrder pass-through', async () => {
    await service.getOrderStatus(supplierId, 'STUB-ORDER-1');
    await service.cancelOrder(supplierId, 'STUB-ORDER-1');
    expect(stub.statusCalls).toEqual(['STUB-ORDER-1']);
    expect(stub.cancelCalls).toEqual(['STUB-ORDER-1']);
  });

  it('throws when the supplier is not isDropshipActive', async () => {
    const db = getDb();
    await db.update(suppliers).set({ isDropshipActive: false }).where(eq(suppliers.id, supplierId));
    await expect(service.getStockAndPrice(supplierId, ['A'])).rejects.toThrow(/not active/);
    await db.update(suppliers).set({ isDropshipActive: true }).where(eq(suppliers.id, supplierId));
  });

  it('throws on an unknown supplier id', async () => {
    await expect(
      service.getStockAndPrice('00000000-0000-4000-8000-000000000000', ['A']),
    ).rejects.toThrow();
  });

  it('encryptApiKey produces decrypt-able ciphertext', async () => {
    const enc = service.encryptApiKey('round-trip');
    // We don't expose decrypt from the service, but the encrypt helper
    // itself is round-trippable — we can re-import to confirm.
    const { decrypt } = await import('../../shared/crypto/encrypt.js');
    expect(decrypt(enc)).toBe('round-trip');
  });
});
