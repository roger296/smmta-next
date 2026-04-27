/**
 * End-to-end integration tests for the storefront write surface.
 *
 *   reserve → commit → ALLOCATED + integrationMetadata + linked stock
 *   replay  — same Idempotency-Key returns the same orderId, no second order
 *   422     — mollie.amount off by 0.50 → no order, reservation released
 *   409     — INSUFFICIENT_STOCK shape on shortage
 *   cancel  — ALLOCATED → CANCELLED, stock items revert to IN_STOCK
 *   auth    — JWT → 401, missing storefront:write → 403
 *   GET     — public-safe order projection
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  apiKeys,
  customerOrders,
  customers,
  customerDeliveryAddresses,
  orderLines,
  productGroups,
  products,
  stockItems,
  stockReservations,
  storefrontIdempotency,
  warehouses,
} from '../../db/schema/index.js';
import { inArray } from 'drizzle-orm';
import { ApiKeyService } from '../admin/api-keys.service.js';

const COMPANY_ID = '88888888-8888-4888-8888-888888888888';
let app: FastifyInstance;
let writeKey: string;
let readOnlyKey: string;
let jwt: string;

interface Seeded {
  warehouseId: string;
  smokeProductId: string;
  amberProductId: string;
}
let seeded: Seeded;

async function wipeAndSeed(): Promise<Seeded> {
  const db = getDb();
  // Wipe in dependency order: order_lines → customer_orders → stock_items.
  const orders = await db
    .select({ id: customerOrders.id })
    .from(customerOrders)
    .where(eq(customerOrders.companyId, COMPANY_ID));
  if (orders.length > 0) {
    const ids = orders.map((o) => o.id);
    await db.delete(orderLines).where(inArray(orderLines.orderId, ids));
    await db.delete(stockItems).where(inArray(stockItems.salesOrderId, ids));
  }
  await db.delete(customerOrders).where(eq(customerOrders.companyId, COMPANY_ID));
  await db.delete(stockItems).where(eq(stockItems.companyId, COMPANY_ID));
  await db.delete(stockReservations).where(eq(stockReservations.companyId, COMPANY_ID));
  await db.delete(storefrontIdempotency).where(eq(storefrontIdempotency.companyId, COMPANY_ID));
  await db.delete(customerDeliveryAddresses).where(
    // Indirect: any address whose customer is in our company
    eq(
      customerDeliveryAddresses.customerId,
      // We'll just hard-clean addresses by company via the cascade-by-customer below.
      '00000000-0000-0000-0000-000000000000',
    ),
  );
  // Clean addresses by joining through customers.
  const cs = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.companyId, COMPANY_ID));
  for (const c of cs) {
    await db.delete(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.customerId, c.id));
  }
  await db.delete(customers).where(eq(customers.companyId, COMPANY_ID));
  await db.delete(products).where(eq(products.companyId, COMPANY_ID));
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY_ID));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY_ID));

  const [wh] = await db
    .insert(warehouses)
    .values({ companyId: COMPANY_ID, name: 'Test WH', isDefault: true })
    .returning({ id: warehouses.id });
  if (!wh) throw new Error('seed: warehouse');

  const productRows = await db
    .insert(products)
    .values([
      {
        companyId: COMPANY_ID,
        name: 'Aurora — Smoke',
        slug: 'aurora-smoke-w',
        colour: 'Smoke',
        colourHex: '#3a3a3a',
        minSellingPrice: '24.00',
        isPublished: true,
      },
      {
        companyId: COMPANY_ID,
        name: 'Aurora — Amber',
        slug: 'aurora-amber-w',
        colour: 'Amber',
        colourHex: '#d97706',
        minSellingPrice: '34.00',
        isPublished: true,
      },
    ])
    .returning({ id: products.id, slug: products.slug });

  const smokeId = productRows.find((p) => p.slug === 'aurora-smoke-w')!.id;
  const amberId = productRows.find((p) => p.slug === 'aurora-amber-w')!.id;

  await db.insert(stockItems).values([
    ...Array.from({ length: 3 }, () => ({
      companyId: COMPANY_ID,
      productId: smokeId,
      warehouseId: wh.id,
      status: 'IN_STOCK' as const,
    })),
    ...Array.from({ length: 1 }, () => ({
      companyId: COMPANY_ID,
      productId: amberId,
      warehouseId: wh.id,
      status: 'IN_STOCK' as const,
    })),
  ]);

  return { warehouseId: wh.id, smokeProductId: smokeId, amberProductId: amberId };
}

const baseAddress = {
  line1: '12 Test Street',
  city: 'London',
  postCode: 'SW1A 1AA',
  country: 'GB',
};

const baseCustomer = {
  email: 'buyer@example.invalid',
  firstName: 'Pat',
  lastName: 'Buyer',
};

async function reserve(
  qtyByProduct: Record<string, number>,
  ttlSeconds = 900,
): Promise<{ reservationId: string }> {
  const items = Object.entries(qtyByProduct).map(([productId, quantity]) => ({
    productId,
    quantity,
  }));
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/storefront/reservations',
    headers: { authorization: `Bearer ${writeKey}` },
    payload: { items, ttlSeconds },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { data: { reservationId: string } };
  return { reservationId: body.data.reservationId };
}

async function commit(
  idempotencyKey: string,
  reservationId: string,
  mollieAmount: string,
  deliveryCharge?: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/storefront/orders',
    headers: {
      authorization: `Bearer ${writeKey}`,
      'idempotency-key': idempotencyKey,
    },
    payload: {
      reservationId,
      customer: baseCustomer,
      deliveryAddress: baseAddress,
      mollie: {
        paymentId: `tr_test_${idempotencyKey}`,
        amount: mollieAmount,
        currency: 'GBP',
        methodPaid: 'creditcard',
        status: 'paid',
      },
      ...(deliveryCharge ? { deliveryCharge } : {}),
    },
  });
  return res;
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();

  const db = getDb();
  await db.delete(apiKeys).where(eq(apiKeys.companyId, COMPANY_ID));

  const service = new ApiKeyService();
  writeKey = (
    await service.issue(COMPANY_ID, {
      name: 'storefront-write-test',
      scopes: ['storefront:read', 'storefront:write'],
    })
  ).rawKey;
  readOnlyKey = (
    await service.issue(COMPANY_ID, {
      name: 'storefront-read-only-test',
      scopes: ['storefront:read'],
    })
  ).rawKey;

  jwt = app.jwt.sign({
    userId: 'op',
    companyId: COMPANY_ID,
    email: 'op@example.invalid',
    roles: ['admin'],
  });
});

beforeEach(async () => {
  seeded = await wipeAndSeed();
});

afterAll(async () => {
  const db = getDb();
  // Clean everything for the test company.
  const finalOrders = await db
    .select({ id: customerOrders.id })
    .from(customerOrders)
    .where(eq(customerOrders.companyId, COMPANY_ID));
  if (finalOrders.length > 0) {
    await db.delete(orderLines).where(inArray(orderLines.orderId, finalOrders.map((o) => o.id)));
  }
  await db.delete(customerOrders).where(eq(customerOrders.companyId, COMPANY_ID));
  await db.delete(stockItems).where(eq(stockItems.companyId, COMPANY_ID));
  await db.delete(stockReservations).where(eq(stockReservations.companyId, COMPANY_ID));
  await db.delete(storefrontIdempotency).where(eq(storefrontIdempotency.companyId, COMPANY_ID));
  const cs = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.companyId, COMPANY_ID));
  for (const c of cs) {
    await db.delete(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.customerId, c.id));
  }
  await db.delete(customers).where(eq(customers.companyId, COMPANY_ID));
  await db.delete(products).where(eq(products.companyId, COMPANY_ID));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY_ID));
  await db.delete(apiKeys).where(eq(apiKeys.companyId, COMPANY_ID));
  await app.close();
  await closeDatabase();
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

describe('POST /storefront/reservations', () => {
  it('reserves stock and returns reservationId + lines', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storefront/reservations',
      headers: { authorization: `Bearer ${writeKey}` },
      payload: {
        items: [{ productId: seeded.smokeProductId, quantity: 2 }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      data: { reservationId: string; expiresAt: string; lines: Array<{ stockItemIds: string[] }> };
    };
    expect(body.data.lines[0]?.stockItemIds).toHaveLength(2);
    expect(new Date(body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('409 INSUFFICIENT_STOCK with productId + available on shortage', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storefront/reservations',
      headers: { authorization: `Bearer ${writeKey}` },
      payload: {
        items: [{ productId: seeded.smokeProductId, quantity: 99 }],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; productId: string; available: number };
    expect(body.error).toBe('INSUFFICIENT_STOCK');
    expect(body.productId).toBe(seeded.smokeProductId);
    expect(body.available).toBe(3);
  });

  it('rejects an api key without storefront:write scope with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storefront/reservations',
      headers: { authorization: `Bearer ${readOnlyKey}` },
      payload: { items: [{ productId: seeded.smokeProductId, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a JWT (not an api key) with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storefront/reservations',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { items: [{ productId: seeded.smokeProductId, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /storefront/reservations/:id', () => {
  it('204 and reverts stock to IN_STOCK', async () => {
    const { reservationId } = await reserve({ [seeded.smokeProductId]: 2 });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/storefront/reservations/${reservationId}`,
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(res.statusCode).toBe(204);

    const db = getDb();
    const items = await db
      .select({ status: stockItems.status })
      .from(stockItems)
      .where(eq(stockItems.companyId, COMPANY_ID));
    expect(items.every((i) => i.status === 'IN_STOCK')).toBe(true);
  });

  it('204 (idempotent) when called twice', async () => {
    const { reservationId } = await reserve({ [seeded.smokeProductId]: 1 });
    const r1 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/storefront/reservations/${reservationId}`,
      headers: { authorization: `Bearer ${writeKey}` },
    });
    const r2 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/storefront/reservations/${reservationId}`,
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(r1.statusCode).toBe(204);
    expect(r2.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// POST /storefront/orders — happy path + replay + total mismatch
// ---------------------------------------------------------------------------

describe('POST /storefront/orders', () => {
  it('reserve → commit produces an ALLOCATED order with mollie metadata + linked stock', async () => {
    const { reservationId } = await reserve({
      [seeded.smokeProductId]: 1,
      [seeded.amberProductId]: 1,
    });
    // 24.00 + 34.00 = 58.00 gross, no shipping
    const res = await commit('IDEMP-COMMIT-001', reservationId, '58.00');
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { orderId: string; status: string } };
    expect(body.data.status).toBe('ALLOCATED');

    const db = getDb();
    const order = await db.query.customerOrders.findFirst({
      where: eq(customerOrders.id, body.data.orderId),
      with: { lines: true },
    });
    expect(order?.status).toBe('ALLOCATED');
    expect(order?.sourceChannel).toBe('API');
    expect(order?.thirdPartyOrderId).toBe('tr_test_IDEMP-COMMIT-001');
    expect(order?.integrationMetadata).toMatchObject({
      mollie: {
        paymentId: 'tr_test_IDEMP-COMMIT-001',
        amount: '58.00',
        currency: 'GBP',
        methodPaid: 'creditcard',
        status: 'paid',
      },
    });
    expect(order?.grandTotal).toBe('58.00');
    expect(order?.lines).toHaveLength(2);

    // All allocated stock items linked to the new order.
    const allocated = await db
      .select({ status: stockItems.status, salesOrderId: stockItems.salesOrderId })
      .from(stockItems)
      .where(and(eq(stockItems.companyId, COMPANY_ID), eq(stockItems.status, 'ALLOCATED')));
    expect(allocated).toHaveLength(2);
    expect(allocated.every((s) => s.salesOrderId === body.data.orderId)).toBe(true);
  });

  it('replay: same Idempotency-Key returns the original response, no second order', async () => {
    const { reservationId } = await reserve({ [seeded.smokeProductId]: 1 });
    const first = await commit('IDEMP-REPLAY-001', reservationId, '24.00');
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { data: { orderId: string } };

    // Second call: identical headers + body. The reservation is now CONVERTED
    // and the second call must NOT touch it; the idempotency cache returns
    // the original response.
    const second = await commit('IDEMP-REPLAY-001', reservationId, '24.00');
    expect(second.statusCode).toBe(201);
    const secondBody = second.json() as { data: { orderId: string } };
    expect(secondBody.data.orderId).toBe(firstBody.data.orderId);

    const db = getDb();
    const orders = await db
      .select({ id: customerOrders.id })
      .from(customerOrders)
      .where(eq(customerOrders.companyId, COMPANY_ID));
    expect(orders).toHaveLength(1);
  });

  it('422 when mollie.amount is off by more than 1p, no order created, reservation released', async () => {
    const { reservationId } = await reserve({ [seeded.smokeProductId]: 1 });
    const res = await commit('IDEMP-MISMATCH-001', reservationId, '23.50'); // off by 0.50
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; expected?: string; received?: string };
    expect(body.error).toMatch(/total mismatch/i);
    expect(body.expected).toBe('24.00');
    expect(body.received).toBe('23.50');

    const db = getDb();
    // No customer order.
    const orders = await db
      .select({ id: customerOrders.id })
      .from(customerOrders)
      .where(eq(customerOrders.companyId, COMPANY_ID));
    expect(orders).toHaveLength(0);
    // Reservation released → stock back to IN_STOCK, reservation status RELEASED.
    const reservation = await db.query.stockReservations.findFirst({
      where: eq(stockReservations.id, reservationId),
    });
    expect(reservation?.status).toBe('RELEASED');
    const items = await db
      .select({ status: stockItems.status })
      .from(stockItems)
      .where(and(eq(stockItems.companyId, COMPANY_ID), isNull(stockItems.deletedAt)));
    expect(items.every((i) => i.status === 'IN_STOCK')).toBe(true);
  });

  it('accepts deliveryCharge and includes it in grandTotal', async () => {
    const { reservationId } = await reserve({ [seeded.smokeProductId]: 1 });
    const res = await commit('IDEMP-DELIVERY-001', reservationId, '28.95', '4.95');
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { orderId: string } };
    const db = getDb();
    const order = await db.query.customerOrders.findFirst({
      where: eq(customerOrders.id, body.data.orderId),
    });
    expect(order?.grandTotal).toBe('28.95');
    expect(order?.deliveryCharge).toBe('4.95');
    expect(order?.orderTotal).toBe('24.00');
  });

  it('400 when Idempotency-Key header is missing', async () => {
    const { reservationId } = await reserve({ [seeded.smokeProductId]: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storefront/orders',
      headers: { authorization: `Bearer ${writeKey}` },
      payload: {
        reservationId,
        customer: baseCustomer,
        deliveryAddress: baseAddress,
        mollie: {
          paymentId: 'tr_test_no_key',
          amount: '24.00',
          currency: 'GBP',
          methodPaid: 'creditcard',
          status: 'paid',
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an api key without storefront:write scope with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storefront/orders',
      headers: {
        authorization: `Bearer ${readOnlyKey}`,
        'idempotency-key': 'X'.repeat(16),
      },
      payload: {
        reservationId: '00000000-0000-4000-8000-000000000000',
        customer: baseCustomer,
        deliveryAddress: baseAddress,
        mollie: {
          paymentId: 'x',
          amount: '0.00',
          currency: 'GBP',
          methodPaid: 'creditcard',
          status: 'paid',
        },
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /storefront/orders/:id
// ---------------------------------------------------------------------------

describe('GET /storefront/orders/:id', () => {
  it('returns a public-safe projection with lines, totals, address, and history', async () => {
    const { reservationId } = await reserve({ [seeded.smokeProductId]: 2 });
    const res = await commit('IDEMP-GETPROJ-001', reservationId, '48.00');
    const body = res.json() as { data: { orderId: string } };
    const orderId = body.data.orderId;

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/storefront/orders/${orderId}`,
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(get.statusCode).toBe(200);
    const order = get.json() as {
      data: {
        status: string;
        totals: { grandTotal: string };
        lines: Array<{ productSlug: string | null; quantity: number; pricePerUnit: string }>;
        deliveryAddress: { line1: string; city: string; postCode: string } | null;
        statusHistory: Array<{ status: string }>;
      };
    };
    expect(order.data.status).toBe('ALLOCATED');
    expect(order.data.totals.grandTotal).toBe('48.00');
    expect(order.data.lines).toHaveLength(1);
    expect(order.data.lines[0]?.productSlug).toBe('aurora-smoke-w');
    expect(order.data.lines[0]?.quantity).toBe(2);
    expect(order.data.deliveryAddress).toEqual({
      line1: '12 Test Street',
      city: 'London',
      postCode: 'SW1A 1AA',
    });
    expect(order.data.statusHistory.length).toBeGreaterThanOrEqual(1);
  });

  it('404 for an order in a different company', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/orders/00000000-0000-4000-8000-000000000000',
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /storefront/orders/:id/cancel
// ---------------------------------------------------------------------------

describe('POST /storefront/orders/:id/cancel', () => {
  it('cancels an ALLOCATED order and reverts ALLOCATED stock to IN_STOCK', async () => {
    const { reservationId } = await reserve({ [seeded.smokeProductId]: 1 });
    const commitRes = await commit('IDEMP-CANCEL-001', reservationId, '24.00');
    const orderId = (commitRes.json() as { data: { orderId: string } }).data.orderId;

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/storefront/orders/${orderId}/cancel`,
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect((cancelRes.json() as { data: { status: string } }).data.status).toBe('CANCELLED');

    const db = getDb();
    const order = await db.query.customerOrders.findFirst({
      where: eq(customerOrders.id, orderId),
    });
    expect(order?.status).toBe('CANCELLED');
    const items = await db
      .select({ status: stockItems.status, salesOrderId: stockItems.salesOrderId })
      .from(stockItems)
      .where(eq(stockItems.companyId, COMPANY_ID));
    // The previously-allocated unit must be IN_STOCK and unlinked from the order.
    expect(items.every((i) => i.status === 'IN_STOCK')).toBe(true);
    expect(items.every((i) => i.salesOrderId === null)).toBe(true);
  });

  it('409 NOT_CANCELLABLE for an already-shipped order', async () => {
    const { reservationId } = await reserve({ [seeded.smokeProductId]: 1 });
    const commitRes = await commit('IDEMP-CANCEL-002', reservationId, '24.00');
    const orderId = (commitRes.json() as { data: { orderId: string } }).data.orderId;

    // Manually move the order into SHIPPED to simulate an order past the
    // cancellation window.
    const db = getDb();
    await db
      .update(customerOrders)
      .set({ status: 'SHIPPED' })
      .where(eq(customerOrders.id, orderId));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/storefront/orders/${orderId}/cancel`,
      headers: { authorization: `Bearer ${writeKey}` },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; currentStatus: string };
    expect(body.error).toBe('NOT_CANCELLABLE');
    expect(body.currentStatus).toBe('SHIPPED');
  });
});
