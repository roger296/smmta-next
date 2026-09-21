/**
 * Allocating stock to orders, against a real database.
 *
 * Three units are seeded. One order takes 2, a second asks for 2 and gets the
 * 1 that is left. Every count the service reports is checked against the
 * stock rows carrying that order's id, so an order can never read as partly
 * allocated while holding nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { customerOrders, customers, orderLines, stockItems } from '../../db/schema/index.js';
import { countStockByStatus, seedStockFor, wipeCompany, type StockFixture } from '../../../test/fixtures/stock.js';
import { OrderService } from './order.service.js';

const COMPANY_ID = '55555555-5555-4555-8555-555555555555';

let fixture: StockFixture;
let customerId: string;
let seq = 0;

async function makeOrder(quantity: number) {
  const db = getDb();
  seq++;
  const [order] = await db
    .insert(customerOrders)
    .values({
      companyId: COMPANY_ID,
      orderNumber: `TEST-ALLOC-${seq}`,
      customerId,
      orderDate: '2026-09-21',
      status: 'CONFIRMED',
    })
    .returning();
  await db.insert(orderLines).values({
    orderId: order!.id,
    productId: fixture.productId,
    quantity,
    pricePerUnit: '10.00',
    lineTotal: (quantity * 10).toFixed(2),
  });
  return order!.id;
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

async function cleanup() {
  const db = getDb();
  await wipeCompany(COMPANY_ID);
  const cs = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, COMPANY_ID));
  if (cs.length > 0) await db.delete(customers).where(inArray(customers.id, cs.map((c) => c.id)));
}

beforeAll(async () => {
  await cleanup();
  fixture = await seedStockFor(COMPANY_ID, 3, { productName: 'Allocation Test Product' });
  const [cust] = await getDb()
    .insert(customers)
    .values({ companyId: COMPANY_ID, name: 'Allocation Test', email: 'buyer@alloc.invalid' })
    .returning();
  customerId = cust!.id;
});

afterAll(async () => {
  await cleanup();
  await closeDatabase();
});

describe('OrderService.allocateStock', () => {
  const service = new OrderService();
  let firstOrder: string;
  let secondOrder: string;

  it('allocates a line in full when the stock is there', async () => {
    firstOrder = await makeOrder(2);
    const result = await service.allocateStock(firstOrder, COMPANY_ID, fixture.warehouseId);

    expect(result).toEqual({ totalAllocated: 2, newlyAllocated: 2, totalShortfall: 0, status: 'ALLOCATED' });
    expect(await rowsHeldBy(firstOrder)).toBe(2);
    expect(await statusOf(firstOrder)).toBe('ALLOCATED');
    expect(await countStockByStatus(COMPANY_ID, fixture.productId)).toMatchObject({ IN_STOCK: 1, ALLOCATED: 2 });
  });

  it('allocates what is left when stock is short, and the rows agree with the count', async () => {
    secondOrder = await makeOrder(2);
    const result = await service.allocateStock(secondOrder, COMPANY_ID, fixture.warehouseId);

    expect(result).toEqual({ totalAllocated: 1, newlyAllocated: 1, totalShortfall: 1, status: 'PARTIALLY_ALLOCATED' });
    expect(await rowsHeldBy(secondOrder)).toBe(result.totalAllocated);
    expect(await statusOf(secondOrder)).toBe('PARTIALLY_ALLOCATED');
    // The first order keeps its two units.
    expect(await rowsHeldBy(firstOrder)).toBe(2);
    expect(await countStockByStatus(COMPANY_ID, fixture.productId)).toMatchObject({ IN_STOCK: 0, ALLOCATED: 3 });
  });

  it('reads back-ordered, holding nothing, when there is no stock at all', async () => {
    const thirdOrder = await makeOrder(1);
    const result = await service.allocateStock(thirdOrder, COMPANY_ID, fixture.warehouseId);

    expect(result).toEqual({ totalAllocated: 0, newlyAllocated: 0, totalShortfall: 1, status: 'BACK_ORDERED' });
    expect(await rowsHeldBy(thirdOrder)).toBe(0);
    expect(await statusOf(thirdOrder)).toBe('BACK_ORDERED');
  });

  it('stays part-allocated when Allocate is pressed again with nothing new in stock', async () => {
    const result = await service.allocateStock(secondOrder, COMPANY_ID, fixture.warehouseId);

    expect(result).toEqual({ totalAllocated: 1, newlyAllocated: 0, totalShortfall: 1, status: 'PARTIALLY_ALLOCATED' });
    expect(await rowsHeldBy(secondOrder)).toBe(1);
  });

  it('tops a part-allocated order up to full without taking units twice', async () => {
    await getDb().insert(stockItems).values(
      Array.from({ length: 2 }).map(() => ({
        companyId: COMPANY_ID,
        productId: fixture.productId,
        warehouseId: fixture.warehouseId,
        quantity: 1,
        status: 'IN_STOCK' as const,
      })),
    );
    const result = await service.allocateStock(secondOrder, COMPANY_ID, fixture.warehouseId);

    expect(result).toEqual({ totalAllocated: 2, newlyAllocated: 1, totalShortfall: 0, status: 'ALLOCATED' });
    expect(await rowsHeldBy(secondOrder)).toBe(2);
    expect(await countStockByStatus(COMPANY_ID, fixture.productId)).toMatchObject({ IN_STOCK: 1, ALLOCATED: 4 });
  });

  it('hands everything back when the order is deallocated', async () => {
    await service.deallocateStock(secondOrder, COMPANY_ID);

    expect(await rowsHeldBy(secondOrder)).toBe(0);
    expect(await countStockByStatus(COMPANY_ID, fixture.productId)).toMatchObject({ IN_STOCK: 3, ALLOCATED: 2 });
  });
});
