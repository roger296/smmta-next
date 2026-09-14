/**
 * Integration test for the supplier-order placer worker.
 *
 * Inserts a customer order with a SUPPLIER fulfilment line, queues a
 * supplier_orders row, and walks the placer through the placed, retried,
 * refused and unknown-outcome paths. The rule under test throughout: an
 * order is only sent again when it certainly never reached the supplier.
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
  isSafeToRetry,
  runSupplierOrderPlacer,
} from './supplier-order-placer.worker.js';
import { supplierOrderIdempotencyKey } from '../modules/suppliers/supplier-order-routing.js';
import {
  registerStubConnectorForTests,
  resetRegistryCacheForTests,
} from '../integrations/suppliers/registry.js';
import {
  SupplierAuthError,
  SupplierUnreachableError,
  SupplierUpstreamError,
} from '../integrations/suppliers/errors.js';
import { resetCryptoForTests } from '../shared/crypto/encrypt.js';
import { FakeSendGrid, resetSendGridForTests, setSendGridForTests } from '../integrations/sendgrid/sendgrid.js';
import { DropshipSupplierService } from '../modules/suppliers/supplier-dropship.service.js';
import type {
  SupplierConnector,
  SupplierOrderRequest,
  SupplierOrderResponse,
} from '../integrations/suppliers/types.js';

const COMPANY = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const SLUG = 'placer-test-supplier';
const service = new DropshipSupplierService();

type StubMode = 'ok' | 'auth-fail' | 'unavailable' | 'server-error' | 'timeout' | 'refused';

class StubConnector implements SupplierConnector {
  public mode: StubMode = 'ok';
  public placeCalls: SupplierOrderRequest[] = [];
  async getStockAndPrice() { return []; }
  async placeOrder(req: SupplierOrderRequest): Promise<SupplierOrderResponse> {
    this.placeCalls.push(req);
    switch (this.mode) {
      case 'auth-fail': throw new SupplierAuthError('401');
      case 'unavailable': throw new SupplierUpstreamError('Upstream 503', { status: 503 });
      case 'server-error': throw new SupplierUpstreamError('Upstream 500', { status: 500 });
      case 'timeout': throw new SupplierUnreachableError('This operation was aborted', { raw: { name: 'AbortError' } });
      case 'refused': throw new SupplierUnreachableError('fetch failed', { raw: { cause: { code: 'ECONNREFUSED' } } });
      default: return { orderRef: `STUB-${this.placeCalls.length}`, status: 'ACCEPTED' };
    }
  }
  async getOrderStatus() { return { orderRef: 'X', status: 'PLACED' }; }
  async cancelOrder() { return { ok: true }; }
}

let productId: string;
let supplierId: string;
let customerOrderId: string;
const stub = new StubConnector();

async function wipe() {
  const db = getDb();
  await db.delete(supplierOrders).where(eq(supplierOrders.companyId, COMPANY));
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

  await db.insert(warehouses).values({ companyId: COMPANY, name: 'Placer WH', isDefault: true });
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

  const [cust] = await db
    .insert(customers)
    .values({ companyId: COMPANY, name: 'Pat Buyer', email: 'pat@placer.invalid' })
    .returning();
  const [addr] = await db
    .insert(customerDeliveryAddresses)
    .values({
      customerId: cust!.id,
      contactName: 'Pat Buyer',
      line1: '12 Test St', city: 'London', postCode: 'SW1A 1AA', country: 'GB',
      phone: '07700 900123',
    })
    .returning();

  const [order] = await db
    .insert(customerOrders)
    .values({
      companyId: COMPANY,
      orderNumber: 'STORE-PLACER-1',
      customerId: cust!.id,
      deliveryAddressId: addr!.id,
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
  resetSendGridForTests();
  await wipe();
  await closeDatabase();
});

beforeEach(async () => {
  stub.mode = 'ok';
  stub.placeCalls.length = 0;
  const db = getDb();
  await db.delete(supplierOrders).where(eq(supplierOrders.customerOrderId, customerOrderId));
  await db.update(suppliers).set({ isDropshipActive: true }).where(eq(suppliers.id, supplierId));
  await db.update(customerOrders).set({ status: 'CONFIRMED' }).where(eq(customerOrders.id, customerOrderId));
});

function queueSupplierOrder() {
  return getDb()
    .insert(supplierOrders)
    .values({
      companyId: COMPANY,
      customerOrderId,
      supplierId,
      idempotencyKey: supplierOrderIdempotencyKey(customerOrderId, supplierId),
      status: 'PENDING',
    })
    .returning();
}

async function reload(id: string) {
  return (await getDb().query.supplierOrders.findFirst({ where: eq(supplierOrders.id, id) }))!;
}

function collectAlerts() {
  const reasons: string[] = [];
  return { reasons, onFailureNotify: (_r: unknown, _s: unknown, reason: string) => { reasons.push(reason); } };
}

describe('runSupplierOrderPlacer — placed', () => {
  it('PENDING → PLACED, sends the SKU lines and our contact details', async () => {
    const [row] = await queueSupplierOrder();
    const outcomes = await runSupplierOrderPlacer();
    expect(outcomes.find((x) => x.supplierOrderId === row!.id)?.result).toBe('PLACED');
    expect(stub.placeCalls).toHaveLength(1);
    const req = stub.placeCalls[0]!;
    expect(req.idempotencyKey).toBe(row!.idempotencyKey);
    expect(req.customerOrderRef).toBe('STORE-PLACER-1');
    expect(req.lines).toEqual([{ supplierSku: 'PLACER-SKU', qty: 2 }]);
    expect(req.contactEmail).toBe('sales@cleverdeals.net');
    expect(req.contactPhone).toBe('07700 900123');

    const updated = await reload(row!.id);
    expect(updated.status).toBe('PLACED');
    expect(updated.supplierOrderRef).toBe('STUB-1');
    expect(updated.requestPayload).toBeTruthy();
    expect(updated.nextRetryAt).toBeNull();
  });
});

describe('runSupplierOrderPlacer — retries only when the order never arrived', () => {
  it('503 → PENDING with a backoff, and the next pass leaves it alone', async () => {
    stub.mode = 'unavailable';
    const [row] = await queueSupplierOrder();
    expect((await runSupplierOrderPlacer())[0]!.result).toBe('PENDING');
    const updated = await reload(row!.id);
    expect(updated.status).toBe('PENDING');
    expect(updated.retryCount).toBe(1);
    expect(updated.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(updated.errorMessage).toMatch(/503/);

    await runSupplierOrderPlacer();
    expect(stub.placeCalls).toHaveLength(1);
  });

  it('a refused connection → PENDING', async () => {
    stub.mode = 'refused';
    const [row] = await queueSupplierOrder();
    await runSupplierOrderPlacer();
    expect((await reload(row!.id)).status).toBe('PENDING');
  });

  it('after 5 retries → FAILED with one alert', async () => {
    stub.mode = 'unavailable';
    const [row] = await queueSupplierOrder();
    const alerts = collectAlerts();
    const db = getDb();
    for (let i = 0; i < 6; i++) {
      await runSupplierOrderPlacer({ onFailureNotify: alerts.onFailureNotify });
      if ((await reload(row!.id)).status === 'FAILED') break;
      // Skip the backoff so the next pass picks the row up.
      await db.update(supplierOrders).set({ nextRetryAt: new Date(0) }).where(eq(supplierOrders.id, row!.id));
    }
    const final = await reload(row!.id);
    expect(final.status).toBe('FAILED');
    expect(final.errorMessage).toMatch(/Not sent after 5 retries/);
    expect(alerts.reasons).toHaveLength(1);
    expect(stub.placeCalls).toHaveLength(6);
  });
});

describe('runSupplierOrderPlacer — FAILED for a person', () => {
  it('a 500 may have created the order → FAILED, outcome unknown', async () => {
    stub.mode = 'server-error';
    const [row] = await queueSupplierOrder();
    const alerts = collectAlerts();
    await runSupplierOrderPlacer({ onFailureNotify: alerts.onFailureNotify });
    const updated = await reload(row!.id);
    expect(updated.status).toBe('FAILED');
    expect(updated.errorMessage).toMatch(/Outcome unknown/);
    expect(alerts.reasons[0]).toMatch(/check before retrying/);
  });

  it('a timeout → FAILED, outcome unknown', async () => {
    stub.mode = 'timeout';
    const [row] = await queueSupplierOrder();
    await runSupplierOrderPlacer({ onFailureNotify: () => {} });
    expect((await reload(row!.id)).errorMessage).toMatch(/Outcome unknown/);
  });

  it('auth failure → FAILED immediately as not accepted', async () => {
    stub.mode = 'auth-fail';
    const [row] = await queueSupplierOrder();
    const alerts = collectAlerts();
    await runSupplierOrderPlacer({ onFailureNotify: alerts.onFailureNotify });
    const updated = await reload(row!.id);
    expect(updated.status).toBe('FAILED');
    expect(updated.errorMessage).toMatch(/did not accept the order/);
    expect(alerts.reasons).toHaveLength(1);
  });

  it('a request recorded with no outcome is not sent again', async () => {
    const [row] = await queueSupplierOrder();
    // What a process killed mid-call leaves behind.
    await getDb()
      .update(supplierOrders)
      .set({ requestPayload: { sent: true }, errorMessage: null })
      .where(eq(supplierOrders.id, row!.id));
    await runSupplierOrderPlacer({ onFailureNotify: () => {} });
    expect(stub.placeCalls).toHaveLength(0);
    const updated = await reload(row!.id);
    expect(updated.status).toBe('FAILED');
    expect(updated.errorMessage).toMatch(/no reply was recorded/);
  });

  it('a product with no supplier SKU → FAILED without calling the supplier', async () => {
    const db = getDb();
    await db.update(supplierProducts).set({ deletedAt: new Date() }).where(eq(supplierProducts.productId, productId));
    try {
      const [row] = await queueSupplierOrder();
      await runSupplierOrderPlacer({ onFailureNotify: () => {} });
      expect(stub.placeCalls).toHaveLength(0);
      expect((await reload(row!.id)).errorMessage).toMatch(/No Placer Supplier SKU/);
    } finally {
      await db.update(supplierProducts).set({ deletedAt: null }).where(eq(supplierProducts.productId, productId));
    }
  });

  it('emails the alert address when no test hook is given', async () => {
    const fake = new FakeSendGrid();
    setSendGridForTests(fake);
    try {
      stub.mode = 'auth-fail';
      await queueSupplierOrder();
      await runSupplierOrderPlacer();
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]!.to).toBe('roger@etailsupport.com');
      expect(fake.sent[0]!.subject).toContain('STORE-PLACER-1');
    } finally {
      resetSendGridForTests();
    }
  });
});

describe('runSupplierOrderPlacer — cancelled orders', () => {
  it('marks the supplier order CANCELLED and sends nothing', async () => {
    await getDb().update(customerOrders).set({ status: 'CANCELLED' }).where(eq(customerOrders.id, customerOrderId));
    const [row] = await queueSupplierOrder();
    expect((await runSupplierOrderPlacer())[0]!.result).toBe('CANCELLED');
    expect(stub.placeCalls).toHaveLength(0);
    expect((await reload(row!.id)).status).toBe('CANCELLED');
  });
});

describe('isSafeToRetry', () => {
  it('retries only errors that prove the order never arrived', () => {
    expect(isSafeToRetry(new SupplierUpstreamError('x', { status: 429 }))).toBe(true);
    expect(isSafeToRetry(new SupplierUpstreamError('x', { status: 503 }))).toBe(true);
    expect(isSafeToRetry(new SupplierUpstreamError('x', { status: 502 }))).toBe(false);
    expect(isSafeToRetry(new SupplierUpstreamError('non-JSON body'))).toBe(false);
    expect(isSafeToRetry(new SupplierUnreachableError('fetch failed', { raw: { cause: { code: 'ENOTFOUND' } } }))).toBe(true);
    expect(isSafeToRetry(new SupplierUnreachableError('This operation was aborted'))).toBe(false);
    expect(isSafeToRetry(new Error('boom'))).toBe(false);
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
