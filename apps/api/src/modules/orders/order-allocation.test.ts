/**
 * Allocating stock to orders, against a real database.
 *
 * Three units are seeded. One order takes 2, a second asks for 2 and gets the
 * 1 that is left. Every count the service reports is checked against the
 * stock rows carrying that order's id, so an order can never read as partly
 * allocated while holding nothing.
 *
 * Full allocation is announced as a domain event, and only full allocation: a
 * shortfall changes the status and says nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { customerOrders, customers, domainEvents, stockItems } from '../../db/schema/index.js';
import { countStockByStatus, seedStockFor, wipeCompany } from '../../../test/fixtures/stock.js';
import { OrderService } from './order.service.js';

const COMPANY_ID = '88888888-8888-4888-8888-888888888888';
const service = new OrderService();

let warehouseId: string;
let productId: string;
let customerId: string;

async function cleanup() {
  await wipeCompany(COMPANY_ID);
  await getDb().delete(domainEvents).where(eq(domainEvents.companyId, COMPANY_ID));
  await getDb().delete(customers).where(eq(customers.companyId, COMPANY_ID));
}

async function allocatedEventsFor(orderId: string) {
  return getDb()
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.companyId, COMPANY_ID), eq(domainEvents.eventType, 'order.allocated'), eq(domainEvents.aggregateId, orderId)));
}

/** Stock rows allocated to the order — what the counts have to agree with. */
async function rowsHeldBy(orderId: string) {
  const rows = await getDb()
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(and(eq(stockItems.salesOrderId, orderId), eq(stockItems.status, 'ALLOCATED')));
  return rows.length;
}

async function statusOf(orderId: string) {
  const [row] = await getDb()
    .select({ status: customerOrders.status })
    .from(customerOrders)
    .where(eq(customerOrders.id, orderId));
  return row!.status;
}

async function createOrder(quantity: number) {
  const order = await service.create(COMPANY_ID, {
    customerId,
    currencyCode: 'GBP',
    deliveryCharge: 0,
    orderDate: '2026-09-21',
    taxInclusive: false,
    vatTreatment: 'STANDARD_VAT_20',
    sourceChannel: 'API',
    lines: [{ productId, quantity, pricePerUnit: 5, taxRate: 20 }],
  });
  return order!;
}

beforeAll(async () => {
  await cleanup();
  const fixture = await seedStockFor(COMPANY_ID, 3);
  warehouseId = fixture.warehouseId;
  productId = fixture.productId;
  const [customer] = await getDb()
    .insert(customers)
    .values({ companyId: COMPANY_ID, name: 'Allocation Customer', email: 'alloc@example.invalid' })
    .returning();
  customerId = customer!.id;
});

afterAll(async () => {
  await cleanup();
  await closeDatabase();
});

describe('OrderService.allocateStock', () => {
  let firstOrder: string;
  let secondOrder: string;

  it('allocates a line in full and emits order.allocated once every line has stock', async () => {
    const order = await createOrder(2);
    firstOrder = order.id;
    const result = await service.allocateStock(order.id, COMPANY_ID, warehouseId);
    expect(result).toEqual({ totalAllocated: 2, newlyAllocated: 2, totalShortfall: 0, status: 'ALLOCATED' });

    const events = await allocatedEventsFor(order.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ orderId: order.id, orderNumber: order.orderNumber, source: 'API' });

    expect(await rowsHeldBy(order.id)).toBe(2);
    expect(await statusOf(order.id)).toBe('ALLOCATED');
    expect(await countStockByStatus(COMPANY_ID, productId)).toMatchObject({ IN_STOCK: 1, ALLOCATED: 2 });
  });

  it('allocates what is left when stock is short, the rows agree with the count, and nothing is emitted', async () => {
    // One unit is left in stock after the order above; this one wants two.
    const order = await createOrder(2);
    secondOrder = order.id;
    const result = await service.allocateStock(order.id, COMPANY_ID, warehouseId);

    expect(result).toEqual({ totalAllocated: 1, newlyAllocated: 1, totalShortfall: 1, status: 'PARTIALLY_ALLOCATED' });
    expect(await rowsHeldBy(order.id)).toBe(result.totalAllocated);
    expect(await statusOf(order.id)).toBe('PARTIALLY_ALLOCATED');
    expect(await allocatedEventsFor(order.id)).toHaveLength(0);
    // The first order keeps its two units.
    expect(await rowsHeldBy(firstOrder)).toBe(2);
    expect(await countStockByStatus(COMPANY_ID, productId)).toMatchObject({ IN_STOCK: 0, ALLOCATED: 3 });
  });

  it('reads back-ordered, holding nothing, when there is no stock at all', async () => {
    const order = await createOrder(1);
    const result = await service.allocateStock(order.id, COMPANY_ID, warehouseId);

    expect(result).toEqual({ totalAllocated: 0, newlyAllocated: 0, totalShortfall: 1, status: 'BACK_ORDERED' });
    expect(await rowsHeldBy(order.id)).toBe(0);
    expect(await statusOf(order.id)).toBe('BACK_ORDERED');
    expect(await allocatedEventsFor(order.id)).toHaveLength(0);
  });

  it('stays part-allocated when Allocate is pressed again with nothing new in stock', async () => {
    const result = await service.allocateStock(secondOrder, COMPANY_ID, warehouseId);

    expect(result).toEqual({ totalAllocated: 1, newlyAllocated: 0, totalShortfall: 1, status: 'PARTIALLY_ALLOCATED' });
    expect(await rowsHeldBy(secondOrder)).toBe(1);
    expect(await allocatedEventsFor(secondOrder)).toHaveLength(0);
  });

  it('tops a part-allocated order up to full without taking units twice, and then emits', async () => {
    await getDb().insert(stockItems).values(
      Array.from({ length: 2 }).map(() => ({
        companyId: COMPANY_ID,
        productId,
        warehouseId,
        quantity: 1,
        status: 'IN_STOCK' as const,
      })),
    );
    const result = await service.allocateStock(secondOrder, COMPANY_ID, warehouseId);

    expect(result).toEqual({ totalAllocated: 2, newlyAllocated: 1, totalShortfall: 0, status: 'ALLOCATED' });
    expect(await rowsHeldBy(secondOrder)).toBe(2);
    expect(await allocatedEventsFor(secondOrder)).toHaveLength(1);
    expect(await countStockByStatus(COMPANY_ID, productId)).toMatchObject({ IN_STOCK: 1, ALLOCATED: 4 });
  });

  it('hands everything back when the order is deallocated', async () => {
    await service.deallocateStock(secondOrder, COMPANY_ID);

    expect(await rowsHeldBy(secondOrder)).toBe(0);
    expect(await countStockByStatus(COMPANY_ID, productId)).toMatchObject({ IN_STOCK: 3, ALLOCATED: 2 });
  });
});
