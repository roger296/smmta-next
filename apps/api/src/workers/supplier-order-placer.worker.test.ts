/**
 * Integration test for the supplier-order placer worker.
 *
 * Inserts a customer order with a SUPPLIER fulfilment line, queues a
 * supplier_orders row, and walks the placer through happy / 5xx /
 * 4xx / network paths.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../config/database.js';
import {
  customerOrders,
  customers,
  customerDeliveryAddresses,
  orderLines,
  productGroups,
  products,
  supplierOrders,
  supplierPollLog,
  supplierProducts,
  suppliers,
  warehouses,
} from '../db/schema/index.js';
import {
  buildIdempotencyKey,
  runSupplierOrderPlacer,
} from './supplier-order-placer.worker.js';
import {
  registerStubConnectorForTests,
  resetRegistryCacheForTests,
} from '../integrations/suppliers/registry.js';
import {
  SupplierAuthError,
  SupplierUpstreamError,
} from '../integrations/suppliers/errors.js';
import { resetCryptoForTests } from '../shared/crypto/encrypt.js';
import { DropshipSupplierService } from '../modules/suppliers/supplier-dropship.service.js';
import type {
  SupplierConnector,
  SupplierOrderRequest,
  SupplierOrderResponse,
} from '../integrations/suppliers/types.js';

const COMPANY = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const SLUG = 'placer-test-supplier';
const service = new DropshipSupplierService();

class StubConnector implements SupplierConnector {
  public mode: 'ok' | 'auth-fail' | 'upstream-fail' = 'ok';
  public placeCalls: SupplierOrderRequest[] = [];
  async getStockAndPrice() { return []; }
  async placeOrder(req: SupplierOrderRequest): Promise<SupplierOrderResponse> {
    this.placeCalls.push(req);
    if (this.mode === 'auth-fail') throw new SupplierAuthError('401');
    if (this.mode === 'upstream-fail') throw new SupplierUpstreamError('500');
    return { orderRef: `STUB-${this.placeCalls.length}`, status: 'ACCEPTED' };
  }
  async getOrderStatus() { return { orderRef: 'X', status: 'PLACED' }; }
  async cancelOrder() { return { ok: true }; }
}

let warehouseId: string;
let productId: string;
let supplierId: string;
let customerId: string;
let deliveryAddressId: string;
let customerOrderId: string;
const stub = new StubConnector();

async function wipe() {
  const db = getDb();
  await db.delete(supplierOrders).where(eq(supplierOrders.companyId, COMPANY));
  // Clean orderLines + customer orders
  const orders = await db.select({ id: customerOrders.id }).from(customerOrders).where(eq(customerOrders.companyId, COMPANY));
  if (orders.length > 0) {
    await db.delete(orderLines).where(inArray(orderLines.orderId, orders.map((o) => o.id)));
    await db.delete(customerOrders).where(inArray(customerOrders.id, orders.map((o) => o.id)));
  }
  // customer_delivery_addresses has no companyId column; join via customer.
  const cs = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, COMPANY));
  if (cs.length > 0) {
    await db.delete(customerDeliveryAddresses).where(inArray(customerDeliveryAddresses.customerId, cs.map((c) => c.id)));
    await db.delete(customers).where(inArray(customers.id, cs.map((c) => c.id)));
  }
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  if (ps.length > 0) {
    await db.delete(products).where(inArray(products.id, ps.map((p) => p.id)));
  }
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY));
  const sup = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.slug, SLUG));
  for (const s of sup) {
    await db.delete(supplierPollLog).where(eq(supplierPollLog.supplierId, s.id));
  }
  await db.delete(suppliers).where(eq(suppliers.slug, SLUG));
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'placer-test-encryption-key-some-entropy';
  resetCryptoForTests();
  resetRegistryCacheForTests();
  await wipe();
  const db = getDb();

  const [w] = await db.insert(warehouses).values({ companyId: COMPANY, name: 'Placer WH', isDefault: true }).returning();
  warehouseId = w!.id;

  const [g] = await db.insert(productGroups).values({ companyId: COMPANY, name: 'Placer Group', slug: 'placer-group' }).returning();
  const [p] = await db.insert(products).values({ companyId: COMPANY, name: 'Placer Product', slug: 'placer-product', groupId: g!.id, minSellingPrice: '12.00' }).returning();
  productId = p!.id;

  const [s] = await db.insert(suppliers).values({
    companyId: COMPANY, name: 'Placer Supplier', slug: SLUG,
    connectorKind: 'STUB', apiBaseUrl: 'https://stub.invalid/', apiKeyEnc: service.encryptApiKey('k'), isDropshipActive: true,
  }).returning();
  supplierId = s!.id;
  registerStubConnectorForTests(supplierId, stub);

  await db.insert(supplierProducts).values({
    companyId: COMPANY, productId, supplierId,
    supplierSku: 'PLACER-SKU', costGbp: '5.00', priority: 100, lastKnownStock: 100, isActive: true,
  });

  // Customer + delivery address.
  const [cust] = await db
    .insert(customers)
    .values({ companyId: COMPANY, name: 'Pat Buyer', email: 'pat@placer.invalid' })
    .returning();
  customerId = cust!.id;
  const [addr] = await db
    .insert(customerDeliveryAddresses)
    .values({
      customerId,
      contactName: 'Pat Buyer',
      line1: '12 Test St', city: 'London', postCode: 'SW1A 1AA', country: 'GB',
    })
    .returning();
  deliveryAddressId = addr!.id;

  const [order] = await db
    .insert(customerOrders)
    .values({
      companyId: COMPANY,
      orderNumber: 'STORE-PLACER-1',
      customerId,
      deliveryAddressId,
      orderDate: new Date().toISOString().slice(0, 10),
      grandTotal: '24.00',
      orderTotal: '24.00',
      taxTotal: '0.00',
      status: 'CONFIRMED',
      sourceChannel: 'API',
    })
    .returning();
  customerOrderId = order!.id;

  await db.insert(orderLines).values({
    orderId: customerOrderId,
    productId,
    quantity: 2,
    pricePerUnit: '12.00',
    lineTotal: '24.00',
    fulfilmentSource: 'SUPPLIER',
    supplierId,
  });
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

beforeEach(async () => {
  stub.mode = 'ok';
  stub.placeCalls.length = 0;
  const db = getDb();
  await db.delete(supplierOrders).where(eq(supplierOrders.customerOrderId, customerOrderId));
  await db.update(suppliers).set({ isDropshipActive: true }).where(eq(suppliers.id, supplierId));
});

function queueSupplierOrder() {
  const db = getDb();
  return db
    .insert(supplierOrders)
    .values({
      companyId: COMPANY,
      customerOrderId,
      supplierId,
      idempotencyKey: buildIdempotencyKey(customerOrderId, supplierId, productId),
      status: 'PENDING',
    })
    .returning();
}

describe('runSupplierOrderPlacer — happy path', () => {
  it('PENDING → PLACED, persists supplierOrderRef + responsePayload', async () => {
    const [row] = await queueSupplierOrder();
    const outcomes = await runSupplierOrderPlacer();
    const o = outcomes.find((x) => x.supplierOrderId === row!.id)!;
    expect(o.result).toBe('PLACED');
    expect(stub.placeCalls).toHaveLength(1);
    expect(stub.placeCalls[0]!.idempotencyKey).toBe(row!.idempotencyKey);
    expect(stub.placeCalls[0]!.lines).toEqual([{ supplierSku: 'PLACER-SKU', qty: 2 }]);

    const db = getDb();
    const updated = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, row!.id) });
    expect(updated!.status).toBe('PLACED');
    expect(updated!.supplierOrderRef).toBe('STUB-1');
    expect(updated!.responsePayload).toBeTruthy();
  });
});

describe('runSupplierOrderPlacer — failure paths', () => {
  it('5xx → status PENDING + nextRetryAt scheduled', async () => {
    stub.mode = 'upstream-fail';
    const [row] = await queueSupplierOrder();
    const outcomes = await runSupplierOrderPlacer();
    expect(outcomes[0]!.result).toBe('PENDING');
    const db = getDb();
    const updated = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, row!.id) });
    expect(updated!.status).toBe('PENDING');
    expect(updated!.retryCount).toBe(1);
    expect(updated!.nextRetryAt).toBeTruthy();
    expect(updated!.errorMessage).toMatch(/500/);
  });

  it('auth fail → status FAILED immediately + onFailureNotify fires', async () => {
    stub.mode = 'auth-fail';
    const [row] = await queueSupplierOrder();
    let notified = false;
    await runSupplierOrderPlacer({ onFailureNotify: () => { notified = true; } });
    const db = getDb();
    const updated = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, row!.id) });
    expect(updated!.status).toBe('FAILED');
    expect(notified).toBe(true);
  });

  it('after 5 transient retries → FAILED + notify', async () => {
    stub.mode = 'upstream-fail';
    const [row] = await queueSupplierOrder();
    let notified = 0;
    // The first run sets retryCount=1 but nextRetryAt is in the future,
    // so subsequent runs would skip. Force the row through the retry
    // budget by manually clearing nextRetryAt between runs.
    const db = getDb();
    for (let i = 0; i < 6; i++) {
      await runSupplierOrderPlacer({ onFailureNotify: () => { notified++; } });
      // Clear nextRetryAt + reset status to PENDING if not already
      // FAILED, so the next iteration picks the row up.
      const r = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, row!.id) });
      if (r?.status === 'FAILED') break;
      await db
        .update(supplierOrders)
        .set({ nextRetryAt: new Date(0) })
        .where(eq(supplierOrders.id, row!.id));
    }
    const final = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, row!.id) });
    expect(final!.status).toBe('FAILED');
    expect(notified).toBe(1); // one notification at the FAILED transition
  });
});

describe('buildIdempotencyKey', () => {
  it('is deterministic per (orderId, supplierId, productId)', () => {
    const k1 = buildIdempotencyKey('a', 'b', 'c');
    const k2 = buildIdempotencyKey('a', 'b', 'c');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(buildIdempotencyKey('a', 'b', 'd'));
  });
});
