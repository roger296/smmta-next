/**
 * Integration tests for queueing supplier orders from a paid order.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  customerOrders,
  customers,
  orderLines,
  products,
  supplierOrders,
  supplierPollLog,
  suppliers,
} from '../../db/schema/index.js';
import {
  orderHasWarehouseLines,
  queueSupplierOrders,
  supplierOrderIdempotencyKey,
} from './supplier-order-routing.js';
import { DropshipSupplierService } from './supplier-dropship.service.js';
import { resetCryptoForTests } from '../../shared/crypto/encrypt.js';

const COMPANY = 'abababab-cdcd-4efe-8a1a-121212121212';
const SLUGS = ['routing-test-a', 'routing-test-b'];

let supplierA: string;
let supplierB: string;
/** Warehouse line + two lines from supplier A + one from supplier B. */
let mixedOrderId: string;
/** Only a supplier-A line. */
let supplierOnlyOrderId: string;

async function wipe() {
  const db = getDb();
  await db.delete(supplierOrders).where(eq(supplierOrders.companyId, COMPANY));
  const orders = await db.select({ id: customerOrders.id }).from(customerOrders).where(eq(customerOrders.companyId, COMPANY));
  if (orders.length > 0) {
    await db.delete(orderLines).where(inArray(orderLines.orderId, orders.map((o) => o.id)));
    await db.delete(customerOrders).where(eq(customerOrders.companyId, COMPANY));
  }
  await db.delete(customers).where(eq(customers.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  const sup = await db.select({ id: suppliers.id }).from(suppliers).where(inArray(suppliers.slug, SLUGS));
  for (const s of sup) await db.delete(supplierPollLog).where(eq(supplierPollLog.supplierId, s.id));
  await db.delete(suppliers).where(inArray(suppliers.slug, SLUGS));
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'routing-test-encryption-key-entropy';
  resetCryptoForTests();
  await wipe();
  const db = getDb();
  const enc = new DropshipSupplierService().encryptApiKey('k');
  const [a] = await db.insert(suppliers).values({ companyId: COMPANY, name: 'Routing A', slug: SLUGS[0], connectorKind: 'STUB', apiBaseUrl: 'https://stub.invalid/', apiKeyEnc: enc, isDropshipActive: true }).returning();
  const [b] = await db.insert(suppliers).values({ companyId: COMPANY, name: 'Routing B', slug: SLUGS[1], connectorKind: 'STUB', apiBaseUrl: 'https://stub.invalid/', apiKeyEnc: enc, isDropshipActive: true }).returning();
  supplierA = a!.id;
  supplierB = b!.id;
  const ps = await db
    .insert(products)
    .values(['w', 'a1', 'a2', 'b1'].map((k) => ({ companyId: COMPANY, name: `Routing ${k}`, slug: `routing-${k}` })))
    .returning({ id: products.id, slug: products.slug });
  const pid = (k: string) => ps.find((p) => p.slug === `routing-${k}`)!.id;
  const [cust] = await db.insert(customers).values({ companyId: COMPANY, name: 'Routing Buyer' }).returning();
  const orderValues = (orderNumber: string) => ({
    companyId: COMPANY,
    orderNumber,
    customerId: cust!.id,
    orderDate: '2026-09-14',
    grandTotal: '10.00',
    orderTotal: '10.00',
    taxTotal: '0.00',
    status: 'ALLOCATED' as const,
    sourceChannel: 'API' as const,
  });
  const [mixed] = await db.insert(customerOrders).values(orderValues('ROUTING-MIXED')).returning();
  const [supplierOnly] = await db.insert(customerOrders).values(orderValues('ROUTING-SUPPLIER')).returning();
  mixedOrderId = mixed!.id;
  supplierOnlyOrderId = supplierOnly!.id;
  const line = (orderId: string, productId: string, supplierId: string | null) => ({
    orderId,
    productId,
    quantity: 1,
    pricePerUnit: '10.00',
    lineTotal: '10.00',
    fulfilmentSource: supplierId ? ('SUPPLIER' as const) : ('WAREHOUSE' as const),
    supplierId,
  });
  await db.insert(orderLines).values([
    line(mixedOrderId, pid('w'), null),
    line(mixedOrderId, pid('a1'), supplierA),
    line(mixedOrderId, pid('a2'), supplierA),
    line(mixedOrderId, pid('b1'), supplierB),
    line(supplierOnlyOrderId, pid('a1'), supplierA),
  ]);
});

beforeEach(async () => {
  const db = getDb();
  await db.delete(supplierOrders).where(eq(supplierOrders.companyId, COMPANY));
  await db.update(customerOrders).set({ status: 'ALLOCATED' }).where(eq(customerOrders.companyId, COMPANY));
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

describe('queueSupplierOrders', () => {
  it('queues one PENDING supplier order per supplier on the order', async () => {
    const r = await queueSupplierOrders(mixedOrderId, COMPANY);
    expect(r.queued).toBe(2);
    expect(r.supplierIds.sort()).toEqual([supplierA, supplierB].sort());
    const rows = await getDb().select().from(supplierOrders).where(eq(supplierOrders.customerOrderId, mixedOrderId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'PENDING')).toBe(true);
    const keyA = rows.find((row) => row.supplierId === supplierA)!.idempotencyKey;
    expect(keyA).toBe(supplierOrderIdempotencyKey(mixedOrderId, supplierA));
  });

  it('queues nothing new when the paid event is replayed', async () => {
    await queueSupplierOrders(mixedOrderId, COMPANY);
    const again = await queueSupplierOrders(mixedOrderId, COMPANY);
    expect(again.queued).toBe(0);
    const rows = await getDb().select().from(supplierOrders).where(eq(supplierOrders.customerOrderId, mixedOrderId));
    expect(rows).toHaveLength(2);
  });

  it('queues nothing for a cancelled order', async () => {
    await getDb().update(customerOrders).set({ status: 'CANCELLED' }).where(eq(customerOrders.id, supplierOnlyOrderId));
    expect(await queueSupplierOrders(supplierOnlyOrderId, COMPANY)).toEqual({ queued: 0, supplierIds: [] });
  });

  it('queues nothing for an unknown order', async () => {
    expect(await queueSupplierOrders('00000000-0000-4000-8000-000000000000', COMPANY)).toEqual({ queued: 0, supplierIds: [] });
  });
});

describe('orderHasWarehouseLines', () => {
  it('tells an order with warehouse lines from a supplier-only one', async () => {
    expect(await orderHasWarehouseLines(mixedOrderId)).toBe(true);
    expect(await orderHasWarehouseLines(supplierOnlyOrderId)).toBe(false);
  });
});
