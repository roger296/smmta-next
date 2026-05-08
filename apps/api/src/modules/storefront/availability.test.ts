/**
 * Integration tests for `getVariantAvailabilityBatch`.
 *
 * Real Postgres at DATABASE_URL. Inserts a fixture product + a couple
 * of supplier mappings, then asserts the three states under different
 * stock-data conditions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  productGroups,
  products,
  stockItems,
  supplierProducts,
  supplierPollLog,
  suppliers,
  warehouses,
} from '../../db/schema/index.js';
import {
  deriveStockState,
  getVariantAvailability,
  getVariantAvailabilityBatch,
} from './availability.js';
import { DropshipSupplierService } from '../suppliers/supplier-dropship.service.js';
import { resetCryptoForTests } from '../../shared/crypto/encrypt.js';

const COMPANY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SLUG = 'avail-test-supplier';
const service = new DropshipSupplierService();

let warehouseId: string;
let productAId: string;
let productBId: string;
let productCId: string;
let supplierId: string;

async function wipe() {
  const db = getDb();
  const supplierRows = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.slug, SLUG));
  for (const s of supplierRows) {
    await db.delete(supplierPollLog).where(eq(supplierPollLog.supplierId, s.id));
  }
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  if (ps.length > 0) {
    await db.delete(stockItems).where(inArray(stockItems.productId, ps.map((p) => p.id)));
    await db.delete(products).where(inArray(products.id, ps.map((p) => p.id)));
  }
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.slug, SLUG));
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'avail-test-encryption-key-some-entropy';
  resetCryptoForTests();
  await wipe();

  const db = getDb();
  const [w] = await db
    .insert(warehouses)
    .values({ companyId: COMPANY, name: 'Avail WH', isDefault: true })
    .returning();
  warehouseId = w!.id;
  const [g] = await db
    .insert(productGroups)
    .values({ companyId: COMPANY, name: 'Avail Group', slug: 'avail-group' })
    .returning();
  const [a] = await db.insert(products).values({ companyId: COMPANY, name: 'A — warehouse', slug: 'avail-a', groupId: g!.id, minSellingPrice: '10.00' }).returning();
  const [b] = await db.insert(products).values({ companyId: COMPANY, name: 'B — supplier-only', slug: 'avail-b', groupId: g!.id, minSellingPrice: '12.00' }).returning();
  const [c] = await db.insert(products).values({ companyId: COMPANY, name: 'C — out of stock', slug: 'avail-c', groupId: g!.id, minSellingPrice: '14.00' }).returning();
  productAId = a!.id;
  productBId = b!.id;
  productCId = c!.id;

  const [supplier] = await db
    .insert(suppliers)
    .values({
      companyId: COMPANY,
      name: 'Avail Test Supplier',
      slug: SLUG,
      connectorKind: 'STUB',
      apiBaseUrl: 'https://stub.invalid/',
      apiKeyEnc: service.encryptApiKey('k'),
      isDropshipActive: true,
    })
    .returning();
  supplierId = supplier!.id;

  // B has supplier stock. C has a supplier mapping but lastKnownStock=0.
  await db.insert(supplierProducts).values([
    {
      companyId: COMPANY,
      productId: productBId,
      supplierId,
      supplierSku: 'B-SKU',
      costGbp: '5.00',
      lastKnownStock: 5,
      isActive: true,
    },
    {
      companyId: COMPANY,
      productId: productCId,
      supplierId,
      supplierSku: 'C-SKU',
      costGbp: '5.00',
      lastKnownStock: 0,
      isActive: true,
    },
  ]);
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

beforeEach(async () => {
  // Reset warehouse stock to the canonical fixture state per test.
  const db = getDb();
  await db.delete(stockItems).where(inArray(stockItems.productId, [productAId, productBId, productCId]));
  await db.insert(stockItems).values([
    { companyId: COMPANY, productId: productAId, warehouseId, status: 'IN_STOCK', quantity: 1 },
    { companyId: COMPANY, productId: productAId, warehouseId, status: 'IN_STOCK', quantity: 1 },
  ]);
});

describe('deriveStockState', () => {
  it('IN_STOCK when warehouse > 0, regardless of supplier', () => {
    expect(deriveStockState(1, 0)).toBe('IN_STOCK');
    expect(deriveStockState(1, 50)).toBe('IN_STOCK');
  });
  it('AVAILABLE_FROM_SUPPLIER when warehouse=0 but supplier > 0', () => {
    expect(deriveStockState(0, 1)).toBe('AVAILABLE_FROM_SUPPLIER');
  });
  it('OUT_OF_STOCK when both are 0', () => {
    expect(deriveStockState(0, 0)).toBe('OUT_OF_STOCK');
  });
});

describe('getVariantAvailabilityBatch', () => {
  it('returns IN_STOCK for warehouse-stocked products', async () => {
    const map = await getVariantAvailabilityBatch(COMPANY, [productAId]);
    const a = map.get(productAId)!;
    expect(a.warehouseFreeStock).toBe(2);
    expect(a.supplierFreeStock).toBe(0);
    expect(a.combinedFreeStock).toBe(2);
    expect(a.stockState).toBe('IN_STOCK');
  });

  it('returns AVAILABLE_FROM_SUPPLIER for supplier-only products', async () => {
    const map = await getVariantAvailabilityBatch(COMPANY, [productBId]);
    const b = map.get(productBId)!;
    expect(b.warehouseFreeStock).toBe(0);
    expect(b.supplierFreeStock).toBe(5);
    expect(b.stockState).toBe('AVAILABLE_FROM_SUPPLIER');
  });

  it('returns OUT_OF_STOCK when both warehouse and supplier are zero', async () => {
    const map = await getVariantAvailabilityBatch(COMPANY, [productCId]);
    const c = map.get(productCId)!;
    expect(c.stockState).toBe('OUT_OF_STOCK');
  });

  it('handles batch lookups correctly', async () => {
    const map = await getVariantAvailabilityBatch(COMPANY, [productAId, productBId, productCId]);
    expect(map.get(productAId)!.stockState).toBe('IN_STOCK');
    expect(map.get(productBId)!.stockState).toBe('AVAILABLE_FROM_SUPPLIER');
    expect(map.get(productCId)!.stockState).toBe('OUT_OF_STOCK');
  });

  it('ignores RESERVED + ALLOCATED stock', async () => {
    const db = getDb();
    await db.insert(stockItems).values({
      companyId: COMPANY,
      productId: productAId,
      warehouseId,
      status: 'RESERVED',
      quantity: 1,
    });
    const a = (await getVariantAvailabilityBatch(COMPANY, [productAId])).get(productAId)!;
    expect(a.warehouseFreeStock).toBe(2); // still 2; RESERVED is excluded
  });

  it('sums supplier stock across multiple active mappings', async () => {
    const db = getDb();
    // Add a second supplier for productB.
    const [supplier2] = await db
      .insert(suppliers)
      .values({
        companyId: COMPANY,
        name: 'Avail Test Supplier 2',
        slug: 'avail-test-supplier-2',
        connectorKind: 'STUB',
        apiBaseUrl: 'https://stub.invalid/',
        apiKeyEnc: service.encryptApiKey('k'),
        isDropshipActive: true,
      })
      .returning();
    await db.insert(supplierProducts).values({
      companyId: COMPANY,
      productId: productBId,
      supplierId: supplier2!.id,
      supplierSku: 'B-SKU-2',
      costGbp: '5.00',
      lastKnownStock: 7,
      isActive: true,
    });
    const b = (await getVariantAvailabilityBatch(COMPANY, [productBId])).get(productBId)!;
    expect(b.supplierFreeStock).toBe(12); // 5 + 7
    // Cleanup the extra mapping
    await db.delete(supplierProducts).where(eq(supplierProducts.supplierId, supplier2!.id));
    await db.delete(suppliers).where(eq(suppliers.id, supplier2!.id));
  });

  it('ignores inactive supplier mappings', async () => {
    const db = getDb();
    await db
      .update(supplierProducts)
      .set({ isActive: false })
      .where(eq(supplierProducts.productId, productBId));
    const b = (await getVariantAvailabilityBatch(COMPANY, [productBId])).get(productBId)!;
    expect(b.supplierFreeStock).toBe(0);
    expect(b.stockState).toBe('OUT_OF_STOCK');
    // Restore
    await db
      .update(supplierProducts)
      .set({ isActive: true })
      .where(eq(supplierProducts.productId, productBId));
  });

  it('returns OUT_OF_STOCK shape for unknown product ids', async () => {
    const unknown = '11111111-2222-4333-8444-555555555555';
    const r = await getVariantAvailability(COMPANY, unknown);
    expect(r.stockState).toBe('OUT_OF_STOCK');
    expect(r.warehouseFreeStock).toBe(0);
    expect(r.supplierFreeStock).toBe(0);
  });

  it('returns an empty map for an empty input', async () => {
    const r = await getVariantAvailabilityBatch(COMPANY, []);
    expect(r.size).toBe(0);
  });
});
