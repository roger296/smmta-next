/**
 * Allocating stock to an order announces full allocation as a domain event,
 * and only full allocation: a shortfall changes the status and says nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { customers, domainEvents, stockItems } from '../../db/schema/index.js';
import { seedStockFor, wipeCompany } from '../../../test/fixtures/stock.js';
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
  it('emits order.allocated once every line has stock', async () => {
    const order = await createOrder(2);
    const result = await service.allocateStock(order.id, COMPANY_ID, warehouseId);
    expect(result).toEqual({ totalAllocated: 2, totalShortfall: 0, status: 'ALLOCATED' });

    const events = await allocatedEventsFor(order.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ orderId: order.id, orderNumber: order.orderNumber, source: 'API' });

    const allocated = await getDb()
      .select()
      .from(stockItems)
      .where(and(eq(stockItems.salesOrderId, order.id), eq(stockItems.status, 'ALLOCATED')));
    expect(allocated).toHaveLength(2);
  });

  it('emits nothing for a partial allocation', async () => {
    // One unit is left in stock after the order above; this one wants two.
    const order = await createOrder(2);
    const result = await service.allocateStock(order.id, COMPANY_ID, warehouseId);
    expect(result.totalShortfall).toBeGreaterThan(0);
    expect(result.status).not.toBe('ALLOCATED');
    expect(await allocatedEventsFor(order.id)).toHaveLength(0);
  });
});
