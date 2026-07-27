/**
 * Integration test for the supplier-poll worker.
 *
 * Real Postgres at DATABASE_URL. Inserts a supplier + a few mapped
 * products, runs the worker via a stub connector, and asserts the
 * DB state. Also exercises the failure paths (auth error and 5xx).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { closeDatabase, getDb } from '../config/database.js';
import {
  productGroups,
  products,
  supplierPollLog,
  supplierProducts,
  suppliers,
} from '../db/schema/index.js';
import {
  resetStockChunkSizeForTests,
  runSupplierPoll,
  setStockChunkSizeForTests,
} from './supplier-poll.worker.js';
import {
  registerStubConnectorForTests,
  resetRegistryCacheForTests,
} from '../integrations/suppliers/registry.js';
import { resetCryptoForTests } from '../shared/crypto/encrypt.js';
import { DropshipSupplierService } from '../modules/suppliers/supplier-dropship.service.js';
import {
  SupplierAuthError,
  SupplierUpstreamError,
} from '../integrations/suppliers/errors.js';
import type {
  SupplierConnector,
  SupplierStockSnapshot,
} from '../integrations/suppliers/types.js';

const COMPANY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUPPLIER_SLUG = 'worker-test-supplier';
const service = new DropshipSupplierService();

class StubConnector implements SupplierConnector {
  public mode: 'ok' | 'auth-fail' | 'upstream-fail' = 'ok';
  public canned = new Map<string, { stock: number | null; cost: number | null }>();
  public calls: string[][] = [];
  /** When set, the function decides per-chunk what to return. Used by
   *  the per-chunk-error-tolerance tests to simulate a transient
   *  upstream blip on chunk N out of N+1. The default `mode`-based
   *  branching above still applies when this is unset. */
  public chunkBehaviour: ((skus: string[], callIndex: number) => SupplierStockSnapshot[] | Error) | null = null;
  async getStockAndPrice(skus: string[]) {
    const callIndex = this.calls.length;
    this.calls.push(skus);
    if (this.chunkBehaviour) {
      const out = this.chunkBehaviour(skus, callIndex);
      if (out instanceof Error) throw out;
      return out;
    }
    if (this.mode === 'auth-fail') throw new SupplierAuthError('401');
    if (this.mode === 'upstream-fail') throw new SupplierUpstreamError('500');
    const out: SupplierStockSnapshot[] = [];
    for (const sku of skus) {
      const entry = this.canned.get(sku);
      if (entry) {
        out.push({ supplierSku: sku, stockQty: entry.stock, costGbp: entry.cost });
      } else {
        out.push({ supplierSku: sku, stockQty: null, costGbp: null });
      }
    }
    return out;
  }
  async placeOrder() { return { orderRef: 'STUB', status: 'ACCEPTED' as const }; }
  async getOrderStatus() { return { orderRef: 'X', status: 'PLACED' }; }
  async cancelOrder() { return { ok: true }; }
}

let supplierId: string;
let productAId: string;
let productBId: string;
const stub = new StubConnector();

async function wipe() {
  const db = getDb();
  // poll log
  await db.delete(supplierPollLog).where(eq(supplierPollLog.companyId, COMPANY));
  // mappings
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  // products + groups
  const ps = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.companyId, COMPANY));
  if (ps.length > 0) {
    await db.delete(products).where(inArray(products.id, ps.map((p) => p.id)));
  }
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY));
  // supplier
  await db.delete(suppliers).where(eq(suppliers.slug, SUPPLIER_SLUG));
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'worker-test-encryption-key-some-entropy';
  resetCryptoForTests();
  resetRegistryCacheForTests();

  await wipe();
  const db = getDb();

  const [g] = await db
    .insert(productGroups)
    .values({ companyId: COMPANY, name: 'Worker Test Group', slug: 'worker-test-group' })
    .returning();
  const [a] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Product A', slug: 'worker-product-a', groupId: g!.id, minSellingPrice: '10.00' })
    .returning();
  const [b] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Product B', slug: 'worker-product-b', groupId: g!.id, minSellingPrice: '12.00' })
    .returning();
  productAId = a!.id;
  productBId = b!.id;

  const [supplier] = await db
    .insert(suppliers)
    .values({
      companyId: COMPANY,
      name: 'Worker Test Supplier',
      slug: SUPPLIER_SLUG,
      connectorKind: 'STUB',
      apiBaseUrl: 'https://stub.invalid/',
      apiKeyEnc: service.encryptApiKey('stub-key'),
      apiAuthScheme: 'bearer',
      isDropshipActive: true,
      pollIntervalMinutes: 60,
    })
    .returning();
  supplierId = supplier!.id;
  registerStubConnectorForTests(supplierId, stub);

  await db.insert(supplierProducts).values([
    {
      companyId: COMPANY,
      productId: productAId,
      supplierId,
      supplierSku: 'SKU-A',
      costGbp: '4.00',
    },
    {
      companyId: COMPANY,
      productId: productBId,
      supplierId,
      supplierSku: 'SKU-B',
      costGbp: '5.00',
    },
  ]);
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

beforeEach(async () => {
  // Reset stub state and clear last-polled cache so cadence is in play.
  stub.mode = 'ok';
  stub.canned.clear();
  stub.calls.length = 0;
  stub.chunkBehaviour = null;
  const db = getDb();
  await db
    .update(supplierProducts)
    .set({ lastPolledAt: null, lastKnownStock: null, lastKnownPrice: null, lastPollError: null, isActive: true, deletedAt: null })
    .where(eq(supplierProducts.supplierId, supplierId));
  await db
    .update(suppliers)
    .set({ lastError: null, consecutiveFailures: 0, isDropshipActive: true })
    .where(eq(suppliers.id, supplierId));
  await db.delete(supplierPollLog).where(eq(supplierPollLog.supplierId, supplierId));
});

describe('runSupplierPoll — happy path', () => {
  it('updates lastKnownStock + lastKnownPrice + lastPolledAt', async () => {
    stub.canned.set('SKU-A', { stock: 12, cost: 4.95 });
    stub.canned.set('SKU-B', { stock: 0, cost: 5.5 });

    const outcomes = await runSupplierPoll();
    const o = outcomes.find((x) => x.supplierId === supplierId)!;
    expect(o.skippedBecause).toBeUndefined();
    expect(o.productsChecked).toBe(2);
    expect(o.productsUpdated).toBe(2);
    expect(o.errorMessage).toBeNull();

    const db = getDb();
    const rows = await db.query.supplierProducts.findMany({
      where: and(eq(supplierProducts.supplierId, supplierId), isNull(supplierProducts.deletedAt)),
    });
    const a = rows.find((r) => r.supplierSku === 'SKU-A')!;
    expect(a.lastKnownStock).toBe(12);
    expect(a.lastKnownPrice).toBe('4.95');
    expect(a.lastPolledAt).toBeTruthy();
    const b = rows.find((r) => r.supplierSku === 'SKU-B')!;
    expect(b.lastKnownStock).toBe(0);
    expect(b.lastKnownPrice).toBe('5.50');

    // poll-log row was written
    const logs = await db.query.supplierPollLog.findMany({
      where: eq(supplierPollLog.supplierId, supplierId),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.productsChecked).toBe(2);
    expect(logs[0]!.productsUpdated).toBe(2);
    expect(logs[0]!.finishedAt).toBeTruthy();
  });

  it('marks SKUs the supplier did not return as sku_not_found', async () => {
    stub.canned.set('SKU-A', { stock: 5, cost: 4.0 });
    // SKU-B not in canned map → connector returns nulls → worker
    // marks the row as sku_not_found.

    await runSupplierPoll();
    const db = getDb();
    const b = (await db.query.supplierProducts.findFirst({
      where: and(eq(supplierProducts.supplierId, supplierId), eq(supplierProducts.supplierSku, 'SKU-B')),
    }))!;
    expect(b.lastPollError).toBe('sku_not_found');
    expect(b.lastKnownStock).toBeNull();
  });
});

describe('runSupplierPoll — cadence', () => {
  it('skips a supplier whose lastPolledAt is within the interval', async () => {
    stub.canned.set('SKU-A', { stock: 1, cost: 1.0 });
    stub.canned.set('SKU-B', { stock: 1, cost: 1.0 });
    await runSupplierPoll();
    stub.calls.length = 0;
    // immediate re-run should be skipped (cadence is 60 minutes)
    const o = (await runSupplierPoll()).find((x) => x.supplierId === supplierId)!;
    expect(o.skippedBecause).toBe('recently-polled');
    expect(stub.calls).toHaveLength(0);
  });

  it('respects --ignore-cadence', async () => {
    stub.canned.set('SKU-A', { stock: 1, cost: 1.0 });
    stub.canned.set('SKU-B', { stock: 1, cost: 1.0 });
    await runSupplierPoll();
    stub.calls.length = 0;
    const o = (await runSupplierPoll({ ignoreCadence: true })).find((x) => x.supplierId === supplierId)!;
    expect(o.skippedBecause).toBeUndefined();
    expect(stub.calls.length).toBeGreaterThan(0);
  });
});

describe('runSupplierPoll — failure paths', () => {
  it('preserves stale snapshots on a 5xx error', async () => {
    // Seed a known snapshot first.
    const db = getDb();
    await db
      .update(supplierProducts)
      .set({ lastKnownStock: 99, lastKnownPrice: '9.99', lastPolledAt: new Date(0) })
      .where(eq(supplierProducts.supplierId, supplierId));

    stub.mode = 'upstream-fail';
    const outcomes = await runSupplierPoll({ ignoreCadence: true });
    const o = outcomes.find((x) => x.supplierId === supplierId)!;
    expect(o.errorMessage).toMatch(/500/);

    const a = (await db.query.supplierProducts.findFirst({
      where: and(eq(supplierProducts.supplierId, supplierId), eq(supplierProducts.supplierSku, 'SKU-A')),
    }))!;
    expect(a.lastKnownStock).toBe(99); // preserved
    expect(a.lastKnownPrice).toBe('9.99');

    const supplier = (await db.query.suppliers.findFirst({
      where: eq(suppliers.id, supplierId),
    }))!;
    expect(supplier.lastError).toMatch(/500/);
    expect(supplier.consecutiveFailures).toBe(1);
  });

  it('disables the supplier after FAILURE_DISABLE_THRESHOLD consecutive failures', async () => {
    stub.mode = 'auth-fail';
    for (let i = 0; i < 5; i++) {
      await runSupplierPoll({ ignoreCadence: true });
    }
    const db = getDb();
    const supplier = (await db.query.suppliers.findFirst({
      where: eq(suppliers.id, supplierId),
    }))!;
    expect(supplier.consecutiveFailures).toBeGreaterThanOrEqual(5);
    expect(supplier.isDropshipActive).toBe(false);
  });

  it('clears lastError + consecutiveFailures on a successful run', async () => {
    const db = getDb();
    await db
      .update(suppliers)
      .set({ lastError: 'old error', consecutiveFailures: 3 })
      .where(eq(suppliers.id, supplierId));
    stub.canned.set('SKU-A', { stock: 1, cost: 1.0 });
    stub.canned.set('SKU-B', { stock: 1, cost: 1.0 });
    await runSupplierPoll({ ignoreCadence: true });
    const supplier = (await db.query.suppliers.findFirst({
      where: eq(suppliers.id, supplierId),
    }))!;
    expect(supplier.lastError).toBeNull();
    expect(supplier.consecutiveFailures).toBe(0);
  });
});

describe('runSupplierPoll — per-chunk error tolerance', () => {
  // For this block we seed enough SKUs to span multiple chunks (chunk
  // size dropped to 2 via the test setter), then assert that one bad
  // chunk doesn't tank the whole poll. Production code keeps the real
  // 100-SKU chunk; the worker reads `stockChunkSize` at runtime.

  const EXTRA_SKUS = ['SKU-C', 'SKU-D', 'SKU-E'];

  beforeAll(async () => {
    const db = getDb();
    // Add three more mappings on top of the SKU-A/B from the suite's
    // beforeAll so the supplier spans multiple chunks at chunk size 2.
    // All the extra SKUs hang off the SAME product on purpose — that is the
    // real-world shape (one supplier listing a main product under several
    // codes / pack sizes) and it exercises the widened identity index
    // `supplier_products_product_supplier_sku_unq` on
    // (product_id, supplier_id, supplier_sku).
    for (const sku of EXTRA_SKUS) {
      const existing = await db.query.supplierProducts.findFirst({
        where: and(
          eq(supplierProducts.supplierId, supplierId),
          eq(supplierProducts.supplierSku, sku),
        ),
      });
      if (!existing) {
        await db.insert(supplierProducts).values({
          companyId: COMPANY,
          productId: productAId,
          supplierId,
          supplierSku: sku,
          costGbp: '4.00',
        });
      }
    }
  });

  afterAll(async () => {
    resetStockChunkSizeForTests();
    const db = getDb();
    await db
      .delete(supplierProducts)
      .where(
        and(
          eq(supplierProducts.supplierId, supplierId),
          inArray(supplierProducts.supplierSku, EXTRA_SKUS),
        ),
      );
  });

  beforeEach(() => {
    setStockChunkSizeForTests(2);
  });

  it('persists successful chunks even when a later chunk fails', async () => {
    // 5 SKUs, chunk size 2 → 3 chunks: [A,B] [C,D] [E].
    // Chunk 0 succeeds, chunk 1 throws 5xx, chunk 2 succeeds.
    stub.chunkBehaviour = (skus, callIndex) => {
      if (callIndex === 1) return new SupplierUpstreamError('500');
      return skus.map((sku) => ({ supplierSku: sku, stockQty: 7, costGbp: 4.5 }));
    };

    const outcomes = await runSupplierPoll({ ignoreCadence: true });
    const o = outcomes.find((x) => x.supplierId === supplierId)!;
    // Partial success: outcome carries the breadcrumb error but
    // counts the SKUs that DID get updated. Chunk 0 = 2 SKUs, chunk
    // 2 = 1 SKU → 3 successful updates out of 5 total.
    expect(o.productsUpdated).toBe(3);
    expect(o.errorMessage).toMatch(/1\/3 chunks failed/);
    expect(o.errorMessage).toMatch(/500/);

    const db = getDb();
    const rows = await db.query.supplierProducts.findMany({
      where: and(eq(supplierProducts.supplierId, supplierId), isNull(supplierProducts.deletedAt)),
    });
    const bySku = new Map(rows.map((r) => [r.supplierSku, r] as const));

    // SKU-A and SKU-B came back in chunk 0 → updated
    expect(bySku.get('SKU-A')!.lastKnownStock).toBe(7);
    expect(bySku.get('SKU-B')!.lastKnownStock).toBe(7);
    // SKU-C and SKU-D were in the failed chunk → snapshots untouched
    // (still null from beforeEach)
    expect(bySku.get('SKU-C')!.lastKnownStock).toBeNull();
    expect(bySku.get('SKU-C')!.lastPolledAt).toBeNull();
    expect(bySku.get('SKU-D')!.lastKnownStock).toBeNull();
    // SKU-E came back in chunk 2 → updated
    expect(bySku.get('SKU-E')!.lastKnownStock).toBe(7);

    // Partial success resets the failure counter — next cycle retries.
    const supplier = (await db.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) }))!;
    expect(supplier.consecutiveFailures).toBe(0);
    expect(supplier.lastError).toMatch(/1\/3 chunks failed/);
    expect(supplier.isDropshipActive).toBe(true);
  });

  it('fails the whole supplier only when EVERY chunk fails', async () => {
    // 5 SKUs, chunk size 2 → 3 chunks, all throw.
    stub.chunkBehaviour = () => new SupplierUpstreamError('500');

    const outcomes = await runSupplierPoll({ ignoreCadence: true });
    const o = outcomes.find((x) => x.supplierId === supplierId)!;
    expect(o.productsUpdated).toBe(0);
    expect(o.errorMessage).toMatch(/500/);

    const db = getDb();
    const supplier = (await db.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) }))!;
    expect(supplier.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(supplier.lastError).toMatch(/500/);
  });

  it('fails fast on a SupplierAuthError without trying subsequent chunks', async () => {
    // Auth error on chunk 0 → don't even try chunks 1+ (credentials
    // won't recover mid-run, no point burning rate-limit budget).
    let calls = 0;
    stub.chunkBehaviour = () => {
      calls++;
      return new SupplierAuthError('401 invalid token');
    };

    await runSupplierPoll({ ignoreCadence: true });
    expect(calls).toBe(1); // bailed after the first chunk
  });
});

describe('runSupplierPoll — onlySupplierId', () => {
  it('only polls the requested supplier', async () => {
    stub.canned.set('SKU-A', { stock: 7, cost: 1.0 });
    stub.canned.set('SKU-B', { stock: 7, cost: 1.0 });
    const outcomes = await runSupplierPoll({ onlySupplierId: supplierId, ignoreCadence: true });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.supplierId).toBe(supplierId);
  });
});
