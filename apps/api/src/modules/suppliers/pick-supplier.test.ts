/**
 * Integration tests for pick-supplier helpers (§D order routing).
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
  decideLineFulfilment,
  getWarehouseFreeStock,
  pickSupplierForProduct,
} from './pick-supplier.js';
import { resetCryptoForTests } from '../../shared/crypto/encrypt.js';
import { DropshipSupplierService } from './supplier-dropship.service.js';

const COMPANY = '11111111-2222-4333-8444-666666666666';
const SLUG_A = 'pick-test-a';
const SLUG_B = 'pick-test-b';
const service = new DropshipSupplierService();

let warehouseId: string;
let productId: string;
let supplierAId: string;
let supplierBId: string;

async function wipe() {
  const db = getDb();
  for (const slug of [SLUG_A, SLUG_B]) {
    const sup = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.slug, slug));
    for (const s of sup) {
      await db.delete(supplierPollLog).where(eq(supplierPollLog.supplierId, s.id));
    }
  }
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  if (ps.length > 0) {
    await db.delete(stockItems).where(inArray(stockItems.productId, ps.map((p) => p.id)));
    await db.delete(products).where(inArray(products.id, ps.map((p) => p.id)));
  }
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY));
  await db.delete(suppliers).where(inArray(suppliers.slug, [SLUG_A, SLUG_B]));
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'pick-test-encryption-key-some-entropy';
  resetCryptoForTests();
  await wipe();
  const db = getDb();
  const [w] = await db.insert(warehouses).values({ companyId: COMPANY, name: 'Pick WH', isDefault: true }).returning();
  warehouseId = w!.id;
  const [g] = await db.insert(productGroups).values({ companyId: COMPANY, name: 'Pick Group', slug: 'pick-group' }).returning();
  const [p] = await db.insert(products).values({ companyId: COMPANY, name: 'Pick Product', slug: 'pick-product', groupId: g!.id, minSellingPrice: '10.00' }).returning();
  productId = p!.id;
  const [a] = await db.insert(suppliers).values({
    companyId: COMPANY, name: 'Supplier A (priority 50)', slug: SLUG_A,
    connectorKind: 'STUB', apiBaseUrl: 'https://stub.invalid/', apiKeyEnc: service.encryptApiKey('k'), isDropshipActive: true,
  }).returning();
  const [b] = await db.insert(suppliers).values({
    companyId: COMPANY, name: 'Supplier B (priority 100)', slug: SLUG_B,
    connectorKind: 'STUB', apiBaseUrl: 'https://stub.invalid/', apiKeyEnc: service.encryptApiKey('k'), isDropshipActive: true,
  }).returning();
  supplierAId = a!.id;
  supplierBId = b!.id;
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

beforeEach(async () => {
  const db = getDb();
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  await db.delete(stockItems).where(eq(stockItems.productId, productId));
});

describe('pickSupplierForProduct', () => {
  it('returns null when no supplier mapping exists', async () => {
    expect(await pickSupplierForProduct(COMPANY, productId, 1)).toBeNull();
  });

  it('returns null when no supplier has enough stock', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId, supplierId: supplierAId,
      supplierSku: 'A', costGbp: '1.00', priority: 50, lastKnownStock: 2, isActive: true,
    });
    expect(await pickSupplierForProduct(COMPANY, productId, 5)).toBeNull();
  });

  it('returns the lowest-priority supplier with enough stock', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values([
      { companyId: COMPANY, productId, supplierId: supplierAId, supplierSku: 'A', costGbp: '1.00', priority: 50, lastKnownStock: 10, isActive: true },
      { companyId: COMPANY, productId, supplierId: supplierBId, supplierSku: 'B', costGbp: '1.00', priority: 100, lastKnownStock: 10, isActive: true },
    ]);
    const r = await pickSupplierForProduct(COMPANY, productId, 5);
    expect(r?.supplierId).toBe(supplierAId);
  });

  it('skips a supplier whose stock is too low and falls through to the next', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values([
      { companyId: COMPANY, productId, supplierId: supplierAId, supplierSku: 'A', costGbp: '1.00', priority: 50, lastKnownStock: 1, isActive: true },
      { companyId: COMPANY, productId, supplierId: supplierBId, supplierSku: 'B', costGbp: '1.00', priority: 100, lastKnownStock: 10, isActive: true },
    ]);
    const r = await pickSupplierForProduct(COMPANY, productId, 5);
    expect(r?.supplierId).toBe(supplierBId);
  });

  it('ignores inactive supplier mappings', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId, supplierId: supplierAId, supplierSku: 'A', costGbp: '1.00',
      priority: 50, lastKnownStock: 100, isActive: false,
    });
    expect(await pickSupplierForProduct(COMPANY, productId, 1)).toBeNull();
  });

  it('ignores suppliers that are not isDropshipActive', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId, supplierId: supplierAId, supplierSku: 'A', costGbp: '1.00',
      priority: 50, lastKnownStock: 100, isActive: true,
    });
    await db.update(suppliers).set({ isDropshipActive: false }).where(eq(suppliers.id, supplierAId));
    expect(await pickSupplierForProduct(COMPANY, productId, 1)).toBeNull();
    await db.update(suppliers).set({ isDropshipActive: true }).where(eq(suppliers.id, supplierAId));
  });
});

describe('decideLineFulfilment', () => {
  it('routes to WAREHOUSE when warehouse can fulfil', async () => {
    const db = getDb();
    await db.insert(stockItems).values([
      { companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK', quantity: 1 },
      { companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK', quantity: 1 },
    ]);
    const r = await decideLineFulfilment(COMPANY, [{ productId, qty: 1 }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decisions[0]!.source).toBe('WAREHOUSE');
    }
  });

  it('routes to SUPPLIER when warehouse is empty and a supplier carries stock', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId, supplierId: supplierAId,
      supplierSku: 'A', costGbp: '1.00', priority: 50, lastKnownStock: 10, isActive: true,
    });
    const r = await decideLineFulfilment(COMPANY, [{ productId, qty: 3 }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decisions[0]!.source).toBe('SUPPLIER');
      expect(r.decisions[0]!.supplierId).toBe(supplierAId);
    }
  });

  it('returns mixed_source_unsupported when warehouse < qty but supplier could close the gap', async () => {
    const db = getDb();
    await db.insert(stockItems).values({ companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK', quantity: 1 });
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId, supplierId: supplierAId,
      supplierSku: 'A', costGbp: '1.00', priority: 50, lastKnownStock: 100, isActive: true,
    });
    const r = await decideLineFulfilment(COMPANY, [{ productId, qty: 5 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.error).toBe('mixed_source_unsupported');
  });

  it('returns insufficient_stock when neither source can fulfil', async () => {
    const r = await decideLineFulfilment(COMPANY, [{ productId, qty: 1 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.error).toBe('insufficient_stock');
  });
});

describe('getWarehouseFreeStock', () => {
  it('counts IN_STOCK rows only', async () => {
    const db = getDb();
    await db.insert(stockItems).values([
      { companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK', quantity: 1 },
      { companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK', quantity: 1 },
      { companyId: COMPANY, productId, warehouseId, status: 'RESERVED', quantity: 1 },
      { companyId: COMPANY, productId, warehouseId, status: 'ALLOCATED', quantity: 1 },
    ]);
    expect(await getWarehouseFreeStock(COMPANY, productId)).toBe(2);
  });
});
