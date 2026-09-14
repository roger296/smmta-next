/**
 * Integration tests for drop-ship lines through checkout: reserving a
 * product only a supplier holds, the supplier stock buffer, the no-split
 * rule, and the SUPPLIER order lines and totals a paid order gets.
 *
 * Real Postgres at DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  customerDeliveryAddresses,
  customerOrders,
  customers,
  orderLines,
  products,
  stockItems,
  stockReservations,
  storefrontIdempotency,
  supplierPollLog,
  supplierProducts,
  suppliers,
  warehouses,
} from '../../db/schema/index.js';
import { InsufficientStockError, ReservationService } from './reservation.service.js';
import { OrderCommitService } from './order-commit.service.js';
import { DropshipSupplierService } from '../suppliers/supplier-dropship.service.js';
import { resetCryptoForTests } from '../../shared/crypto/encrypt.js';

const COMPANY = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const SLUG = 'reservation-dropship-test';
const reservations = new ReservationService();
const commits = new OrderCommitService();

let warehouseId: string;
/** Two units in the warehouse; the supplier also carries it. */
let warehouseProductId: string;
/** No warehouse stock; the supplier holds 10 with a buffer of 5. */
let supplierProductId: string;
let supplierId: string;

async function wipe() {
  const db = getDb();
  const orders = await db
    .select({ id: customerOrders.id })
    .from(customerOrders)
    .where(eq(customerOrders.companyId, COMPANY));
  if (orders.length > 0) {
    const ids = orders.map((o) => o.id);
    await db.delete(orderLines).where(inArray(orderLines.orderId, ids));
    await db.delete(stockItems).where(inArray(stockItems.salesOrderId, ids));
  }
  await db.delete(customerOrders).where(eq(customerOrders.companyId, COMPANY));
  await db.delete(stockItems).where(eq(stockItems.companyId, COMPANY));
  await db.delete(stockReservations).where(eq(stockReservations.companyId, COMPANY));
  await db.delete(storefrontIdempotency).where(eq(storefrontIdempotency.companyId, COMPANY));
  const cs = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, COMPANY));
  if (cs.length > 0) {
    await db.delete(customerDeliveryAddresses).where(inArray(customerDeliveryAddresses.customerId, cs.map((c) => c.id)));
  }
  await db.delete(customers).where(eq(customers.companyId, COMPANY));
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  const sup = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.slug, SLUG));
  for (const s of sup) await db.delete(supplierPollLog).where(eq(supplierPollLog.supplierId, s.id));
  await db.delete(suppliers).where(eq(suppliers.slug, SLUG));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY));
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'dropship-reservation-test-key-entropy';
  resetCryptoForTests();
  await wipe();
  const db = getDb();
  const [w] = await db.insert(warehouses).values({ companyId: COMPANY, name: 'Drop-ship WH', isDefault: true }).returning();
  warehouseId = w!.id;
  const [wp] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Warehouse polo', slug: 'ds-warehouse-polo', minSellingPrice: '10.00' })
    .returning();
  const [sp] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Supplier hoodie', slug: 'ds-supplier-hoodie', minSellingPrice: '12.00' })
    .returning();
  warehouseProductId = wp!.id;
  supplierProductId = sp!.id;
  const [s] = await db
    .insert(suppliers)
    .values({
      companyId: COMPANY,
      name: 'Drop-ship Test Supplier',
      slug: SLUG,
      connectorKind: 'STUB',
      apiBaseUrl: 'https://stub.invalid/',
      apiKeyEnc: new DropshipSupplierService().encryptApiKey('k'),
      isDropshipActive: true,
      stockBuffer: 5,
    })
    .returning();
  supplierId = s!.id;
  await db.insert(supplierProducts).values([
    { companyId: COMPANY, productId: warehouseProductId, supplierId, supplierSku: 'WP-1', costGbp: '5.00', lastKnownStock: 100 },
    { companyId: COMPANY, productId: supplierProductId, supplierId, supplierSku: 'SH-1', costGbp: '6.00', lastKnownStock: 10 },
  ]);
});

beforeEach(async () => {
  const db = getDb();
  const orders = await db.select({ id: customerOrders.id }).from(customerOrders).where(eq(customerOrders.companyId, COMPANY));
  if (orders.length > 0) await db.delete(orderLines).where(inArray(orderLines.orderId, orders.map((o) => o.id)));
  await db.delete(stockItems).where(eq(stockItems.companyId, COMPANY));
  await db.delete(customerOrders).where(eq(customerOrders.companyId, COMPANY));
  await db.delete(stockReservations).where(eq(stockReservations.companyId, COMPANY));
  await db.insert(stockItems).values([
    { companyId: COMPANY, productId: warehouseProductId, warehouseId, status: 'IN_STOCK', quantity: 1 },
    { companyId: COMPANY, productId: warehouseProductId, warehouseId, status: 'IN_STOCK', quantity: 1 },
  ]);
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

async function expectInsufficient(promise: Promise<unknown>, available: number) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InsufficientStockError);
  expect((err as InsufficientStockError).available).toBe(available);
}

describe('createReservation — drop-ship lines', () => {
  it('reserves a supplier-only product without holding any stock', async () => {
    const r = await reservations.createReservation(COMPANY, {
      items: [{ productId: supplierProductId, quantity: 3 }],
      ttlSeconds: 900,
    });
    expect(r.lines).toEqual([
      { productId: supplierProductId, quantity: 3, source: 'SUPPLIER', supplierId, stockItemIds: [] },
    ]);
    const row = await getDb().query.stockReservations.findFirst({ where: eq(stockReservations.id, r.reservationId) });
    expect(row?.metadata?.supplierLines).toEqual([{ productId: supplierProductId, quantity: 3, supplierId }]);
  });

  it('refuses more than the supplier holds above its stock buffer', async () => {
    // 10 held, buffer 5 → 5 can be sold.
    await expectInsufficient(
      reservations.createReservation(COMPANY, { items: [{ productId: supplierProductId, quantity: 6 }], ttlSeconds: 900 }),
      5,
    );
    const held = await getDb().select().from(stockReservations).where(eq(stockReservations.companyId, COMPANY));
    expect(held).toHaveLength(0);
  });

  it('never splits a line between the warehouse and a supplier', async () => {
    // Warehouse holds 2; the supplier could cover 3 but V1 does not split.
    await expectInsufficient(
      reservations.createReservation(COMPANY, { items: [{ productId: warehouseProductId, quantity: 3 }], ttlSeconds: 900 }),
      2,
    );
    const items = await getDb().select({ status: stockItems.status }).from(stockItems).where(eq(stockItems.companyId, COMPANY));
    expect(items.every((i) => i.status === 'IN_STOCK')).toBe(true);
  });

  it('prefers the warehouse when it can supply the whole line', async () => {
    const r = await reservations.createReservation(COMPANY, {
      items: [{ productId: warehouseProductId, quantity: 2 }],
      ttlSeconds: 900,
    });
    expect(r.lines[0]?.source).toBe('WAREHOUSE');
    expect(r.lines[0]?.stockItemIds).toHaveLength(2);
  });

  it('merges repeated lines for the same product', async () => {
    const r = await reservations.createReservation(COMPANY, {
      items: [
        { productId: supplierProductId, quantity: 1 },
        { productId: supplierProductId, quantity: 2 },
      ],
      ttlSeconds: 900,
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.quantity).toBe(3);
  });
});

describe('commitOrder — drop-ship lines', () => {
  it('creates a SUPPLIER order line and prices it with the delivery charge', async () => {
    const r = await reservations.createReservation(COMPANY, {
      items: [
        { productId: warehouseProductId, quantity: 1 },
        { productId: supplierProductId, quantity: 2 },
      ],
      ttlSeconds: 900,
    });
    // 1 × £10 + 2 × £12 + £7 delivery = £41.
    const result = await commits.commitOrder(COMPANY, 'IDEMP-DROPSHIP-001', {
      reservationId: r.reservationId,
      customer: { email: 'dropship@example.invalid', firstName: 'Sam', lastName: 'Buyer' },
      deliveryAddress: { line1: '1 Test Road', city: 'Leeds', postCode: 'LS1 1AA', country: 'GB' },
      mollie: { paymentId: 'tr_dropship_1', amount: '41.00', currency: 'GBP', methodPaid: 'creditcard', status: 'paid' },
      deliveryCharge: '7.00',
    });
    expect(result.status).toBe(201);
    const orderId = (result.body as { data: { orderId: string } }).data.orderId;

    const db = getDb();
    const order = await db.query.customerOrders.findFirst({ where: eq(customerOrders.id, orderId), with: { lines: true } });
    expect(order?.grandTotal).toBe('41.00');
    expect(order?.deliveryCharge).toBe('7.00');
    const byProduct = new Map(order!.lines.map((l) => [l.productId, l]));
    expect(byProduct.get(warehouseProductId)).toMatchObject({ fulfilmentSource: 'WAREHOUSE', supplierId: null, quantity: 1 });
    const supplierLine = byProduct.get(supplierProductId);
    expect(supplierLine).toMatchObject({ fulfilmentSource: 'SUPPLIER', supplierId, quantity: 2 });
    expect(Number(supplierLine?.pricePerUnit)).toBe(12);
    expect(Number(supplierLine?.lineTotal)).toBe(24);

    const allocated = await db.select({ status: stockItems.status }).from(stockItems).where(eq(stockItems.salesOrderId, orderId));
    expect(allocated).toEqual([{ status: 'ALLOCATED' }]);
    const reservation = await db.query.stockReservations.findFirst({ where: eq(stockReservations.id, r.reservationId) });
    expect(reservation?.status).toBe('CONVERTED');
  });

  it('commits an order made only of supplier lines', async () => {
    const r = await reservations.createReservation(COMPANY, {
      items: [{ productId: supplierProductId, quantity: 1 }],
      ttlSeconds: 900,
    });
    const result = await commits.commitOrder(COMPANY, 'IDEMP-DROPSHIP-002', {
      reservationId: r.reservationId,
      customer: { email: 'dropship@example.invalid', firstName: 'Sam', lastName: 'Buyer' },
      deliveryAddress: { line1: '1 Test Road', city: 'Leeds', postCode: 'LS1 1AA', country: 'GB' },
      mollie: { paymentId: 'tr_dropship_2', amount: '19.00', currency: 'GBP', methodPaid: 'creditcard', status: 'paid' },
      deliveryCharge: '7.00',
    });
    expect(result.status).toBe(201);
    const orderId = (result.body as { data: { orderId: string } }).data.orderId;
    const lines = await getDb().select().from(orderLines).where(eq(orderLines.orderId, orderId));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ fulfilmentSource: 'SUPPLIER', supplierId });
  });
});
