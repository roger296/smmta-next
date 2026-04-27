/**
 * Integration tests for ReservationService — happy path, partial-stock,
 * idempotent release, expiry, and convert-to-order.
 *
 * Concurrency tests (race for last unit, 100 iterations) live in
 * `reservation.concurrency.test.ts` so that file can use `eslint-disable
 * @typescript-eslint/no-floating-promises` without polluting this one.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  customerOrders,
  customers,
  stockItems,
  stockReservations,
} from '../../db/schema/index.js';
import {
  InsufficientStockError,
  ReservationService,
  ReservationStateError,
} from './reservation.service.js';
import { countStockByStatus, seedStockFor, wipeCompany } from '../../../test/fixtures/stock.js';

const COMPANY_ID = '55555555-5555-4555-8555-555555555555';
const service = new ReservationService();

afterAll(async () => {
  await wipeCompany(COMPANY_ID);
  await closeDatabase();
});

describe('createReservation — happy path', () => {
  beforeEach(async () => {
    await seedStockFor(COMPANY_ID, 5);
  });

  it('locks N rows to RESERVED and returns the reservation', async () => {
    const fx = await seedStockFor(COMPANY_ID, 5);
    const result = await service.createReservation(COMPANY_ID, {
      items: [{ productId: fx.productId, quantity: 3 }],
      ttlSeconds: 900,
    });

    expect(result.status).toBe('HELD');
    expect(result.reservationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.stockItemIds).toHaveLength(3);

    const counts = await countStockByStatus(COMPANY_ID, fx.productId);
    expect(counts).toEqual({ IN_STOCK: 2, RESERVED: 3, ALLOCATED: 0 });

    const db = getDb();
    const reservation = await db.query.stockReservations.findFirst({
      where: eq(stockReservations.id, result.reservationId),
    });
    expect(reservation?.status).toBe('HELD');
    expect(reservation?.expiresAt).toBeInstanceOf(Date);
    expect(reservation!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('records reservation_id back-link on each held stock item', async () => {
    const fx = await seedStockFor(COMPANY_ID, 2);
    const result = await service.createReservation(COMPANY_ID, {
      items: [{ productId: fx.productId, quantity: 2 }],
      ttlSeconds: 900,
    });
    const db = getDb();
    const items = await db
      .select({ id: stockItems.id, reservationId: stockItems.reservationId, status: stockItems.status })
      .from(stockItems)
      .where(eq(stockItems.companyId, COMPANY_ID));
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.status).toBe('RESERVED');
      expect(it.reservationId).toBe(result.reservationId);
    }
  });
});

describe('createReservation — insufficient stock', () => {
  it('throws InsufficientStockError with the count we managed to lock', async () => {
    const fx = await seedStockFor(COMPANY_ID, 2);
    await expect(
      service.createReservation(COMPANY_ID, {
        items: [{ productId: fx.productId, quantity: 5 }],
        ttlSeconds: 900,
      }),
    ).rejects.toMatchObject({
      name: 'InsufficientStockError',
      productId: fx.productId,
      available: 2,
      requested: 5,
    });

    // Rollback must be complete — no RESERVED rows leaked.
    const counts = await countStockByStatus(COMPANY_ID, fx.productId);
    expect(counts).toEqual({ IN_STOCK: 2, RESERVED: 0, ALLOCATED: 0 });

    // And no HELD reservation row was committed.
    const db = getDb();
    const reservations = await db
      .select({ id: stockReservations.id })
      .from(stockReservations)
      .where(
        and(eq(stockReservations.companyId, COMPANY_ID), eq(stockReservations.status, 'HELD')),
      );
    expect(reservations).toHaveLength(0);
  });
});

describe('releaseReservation — idempotent', () => {
  it('reverts RESERVED → IN_STOCK and is a no-op on the second call', async () => {
    const fx = await seedStockFor(COMPANY_ID, 3);
    const reserved = await service.createReservation(COMPANY_ID, {
      items: [{ productId: fx.productId, quantity: 2 }],
      ttlSeconds: 900,
    });

    const first = await service.releaseReservation(reserved.reservationId, COMPANY_ID);
    expect(first.status).toBe('RELEASED');
    const after1 = await countStockByStatus(COMPANY_ID, fx.productId);
    expect(after1).toEqual({ IN_STOCK: 3, RESERVED: 0, ALLOCATED: 0 });

    // Second call is idempotent — returns RELEASED, no row state changes.
    const second = await service.releaseReservation(reserved.reservationId, COMPANY_ID);
    expect(second.status).toBe('RELEASED');
    const after2 = await countStockByStatus(COMPANY_ID, fx.productId);
    expect(after2).toEqual({ IN_STOCK: 3, RESERVED: 0, ALLOCATED: 0 });
  });

  it('returns NOT_FOUND for an unknown id', async () => {
    const result = await service.releaseReservation(
      '00000000-0000-4000-8000-000000000000',
      COMPANY_ID,
    );
    expect(result.status).toBe('NOT_FOUND');
  });
});

describe('expireReservations', () => {
  it('moves HELD reservations whose expires_at has passed back to IN_STOCK', async () => {
    const fx = await seedStockFor(COMPANY_ID, 2);
    const reserved = await service.createReservation(COMPANY_ID, {
      items: [{ productId: fx.productId, quantity: 2 }],
      ttlSeconds: 900,
    });

    // Force expires_at into the past so the next sweep picks this up.
    const db = getDb();
    await db
      .update(stockReservations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(stockReservations.id, reserved.reservationId));

    const expiredCount = await service.expireReservations();
    expect(expiredCount).toBe(1);

    const counts = await countStockByStatus(COMPANY_ID, fx.productId);
    expect(counts).toEqual({ IN_STOCK: 2, RESERVED: 0, ALLOCATED: 0 });

    const reservation = await db.query.stockReservations.findFirst({
      where: eq(stockReservations.id, reserved.reservationId),
    });
    expect(reservation?.status).toBe('EXPIRED');
  });

  it('leaves still-live HELD reservations untouched', async () => {
    const fx = await seedStockFor(COMPANY_ID, 1);
    const reserved = await service.createReservation(COMPANY_ID, {
      items: [{ productId: fx.productId, quantity: 1 }],
      ttlSeconds: 900,
    });
    const expiredCount = await service.expireReservations();
    expect(expiredCount).toBe(0);

    const db = getDb();
    const reservation = await db.query.stockReservations.findFirst({
      where: eq(stockReservations.id, reserved.reservationId),
    });
    expect(reservation?.status).toBe('HELD');
    const counts = await countStockByStatus(COMPANY_ID, fx.productId);
    expect(counts).toEqual({ IN_STOCK: 0, RESERVED: 1, ALLOCATED: 0 });
  });
});

describe('convertReservation', () => {
  it('flips RESERVED stock to ALLOCATED, creates a customer order, and returns the orderId', async () => {
    const fx = await seedStockFor(COMPANY_ID, 2);

    // The convertReservation contract expects the caller to have resolved
    // a customer row. Insert a minimal one for the test.
    const db = getDb();
    const [customer] = await db
      .insert(customers)
      .values({
        companyId: COMPANY_ID,
        name: 'Test Customer',
        email: 'test@example.invalid',
      })
      .returning({ id: customers.id });
    if (!customer) throw new Error('test customer insert failed');

    const reserved = await service.createReservation(COMPANY_ID, {
      items: [{ productId: fx.productId, quantity: 2 }],
      ttlSeconds: 900,
    });

    const { orderId } = await service.convertReservation(reserved.reservationId, COMPANY_ID, {
      orderNumber: 'TEST-001',
      customerId: customer.id,
      orderDate: '2026-04-27',
      thirdPartyOrderId: 'tr_test_001',
      integrationMetadata: { mollie: { paymentId: 'tr_test_001' } },
      totals: {
        deliveryCharge: '0',
        orderTotal: '20.00',
        taxTotal: '4.00',
        grandTotal: '24.00',
      },
      linePrices: {
        [fx.productId]: { pricePerUnit: '10.00', lineTotal: '20.00', taxRate: 20, taxValue: '4.00' },
      },
    });

    expect(orderId).toMatch(/^[0-9a-f-]{36}$/);

    // All stock items should now be ALLOCATED with sales_order_id set and
    // reservation_id cleared.
    const items = await db
      .select({
        status: stockItems.status,
        salesOrderId: stockItems.salesOrderId,
        reservationId: stockItems.reservationId,
      })
      .from(stockItems)
      .where(and(eq(stockItems.companyId, COMPANY_ID), isNull(stockItems.deletedAt)));
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.status).toBe('ALLOCATED');
      expect(it.salesOrderId).toBe(orderId);
      expect(it.reservationId).toBeNull();
    }

    const reservation = await db.query.stockReservations.findFirst({
      where: eq(stockReservations.id, reserved.reservationId),
    });
    expect(reservation?.status).toBe('CONVERTED');

    const order = await db.query.customerOrders.findFirst({
      where: eq(customerOrders.id, orderId),
      with: { lines: true },
    });
    expect(order?.status).toBe('ALLOCATED');
    expect(order?.sourceChannel).toBe('API');
    expect(order?.thirdPartyOrderId).toBe('tr_test_001');
    expect(order?.integrationMetadata).toMatchObject({ mollie: { paymentId: 'tr_test_001' } });
    expect(order?.lines).toHaveLength(1);
    expect(Number(order!.lines[0]!.quantity)).toBe(2);
  });

  it('throws ReservationStateError when the reservation is already RELEASED', async () => {
    const fx = await seedStockFor(COMPANY_ID, 1);
    const reserved = await service.createReservation(COMPANY_ID, {
      items: [{ productId: fx.productId, quantity: 1 }],
      ttlSeconds: 900,
    });
    await service.releaseReservation(reserved.reservationId, COMPANY_ID);

    await expect(
      service.convertReservation(reserved.reservationId, COMPANY_ID, {
        orderNumber: 'TEST-002',
        customerId: '00000000-0000-4000-8000-000000000000',
        orderDate: '2026-04-27',
        totals: { orderTotal: '10', taxTotal: '0', grandTotal: '10' },
        linePrices: {},
      }),
    ).rejects.toBeInstanceOf(ReservationStateError);
  });
});

describe('error handling — invalid quantity', () => {
  it('rejects zero / negative / non-integer quantity', async () => {
    const fx = await seedStockFor(COMPANY_ID, 5);
    await expect(
      service.createReservation(COMPANY_ID, {
        items: [{ productId: fx.productId, quantity: 0 }],
        ttlSeconds: 900,
      }),
    ).rejects.toThrow(/Invalid quantity/);
    await expect(
      service.createReservation(COMPANY_ID, {
        items: [{ productId: fx.productId, quantity: -1 }],
        ttlSeconds: 900,
      }),
    ).rejects.toThrow(/Invalid quantity/);
    await expect(
      service.createReservation(COMPANY_ID, {
        items: [{ productId: fx.productId, quantity: 1.5 }],
        ttlSeconds: 900,
      }),
    ).rejects.toThrow(/Invalid quantity/);
  });
});

// Suppress unused-import warning for InsufficientStockError — used via .toMatchObject above.
void InsufficientStockError;
