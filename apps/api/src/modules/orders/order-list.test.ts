/**
 * The orders list and detail responses carry the customer's name, and the list
 * can be searched by it.
 *
 * The admin SPA reads `customerName`, but the API only returned the customer
 * nested under `customer`, so every orders screen showed a slice of the
 * customer UUID instead. That is a contract mismatch between two apps, which a
 * unit test on either side alone cannot see — so this runs the real query
 * against a real database and asserts on the shape that comes back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { customers, customerOrders } from '../../db/schema/index.js';
import { wipeCompany } from '../../../test/fixtures/stock.js';
import { OrderService } from './order.service.js';
import type { OrderQueryInput } from './order.schema.js';

// Throwaway company so this suite cannot touch or be affected by other data.
const COMPANY_ID = '66666666-6666-4666-8666-666666666666';

const service = new OrderService();
let aliceId: string;
let bobId: string;
let aliceOrderId: string;

const query = (search?: string): OrderQueryInput =>
  ({ page: 1, pageSize: 50, sortDirection: 'desc', search }) as OrderQueryInput;

async function cleanup() {
  // wipeCompany removes orders and their lines but not customers, and orders
  // reference customers, so customers go last.
  await wipeCompany(COMPANY_ID);
  await getDb().delete(customers).where(eq(customers.companyId, COMPANY_ID));
}

beforeAll(async () => {
  await cleanup();
  const db = getDb();
  const [alice] = await db
    .insert(customers)
    .values({ companyId: COMPANY_ID, name: 'Alice Printworks', email: 'alice@orders.invalid' })
    .returning();
  const [bob] = await db
    .insert(customers)
    .values({ companyId: COMPANY_ID, name: 'Bob Makerspace', email: 'bob@orders.invalid' })
    .returning();
  aliceId = alice!.id;
  bobId = bob!.id;

  const [aliceOrder] = await db
    .insert(customerOrders)
    .values({
      companyId: COMPANY_ID,
      orderNumber: 'TEST-ALICE-0001',
      customerId: aliceId,
      customerOrderNumber: 'PO-ALPHA',
      orderDate: '2026-09-10',
    })
    .returning();
  aliceOrderId = aliceOrder!.id;
  await db.insert(customerOrders).values({
    companyId: COMPANY_ID,
    orderNumber: 'TEST-BOB-0002',
    customerId: bobId,
    customerOrderNumber: 'PO-BRAVO',
    orderDate: '2026-09-10',
  });
});

afterAll(async () => {
  await cleanup();
  await closeDatabase();
});

describe('orders list — customer name', () => {
  it('returns each order with its customer name at the top level', async () => {
    const result = await service.list(COMPANY_ID, query());
    expect(result.data).toHaveLength(2);
    const byNumber = Object.fromEntries(result.data.map((o) => [o.orderNumber, o]));
    expect(byNumber['TEST-ALICE-0001']!.customerName).toBe('Alice Printworks');
    expect(byNumber['TEST-BOB-0002']!.customerName).toBe('Bob Makerspace');
  });

  it('finds orders by part of the customer name, ignoring case', async () => {
    const result = await service.list(COMPANY_ID, query('printworks'));
    expect(result.data.map((o) => o.orderNumber)).toEqual(['TEST-ALICE-0001']);
  });

  it('reports a total that matches the rows a name search returns', async () => {
    // The count and the rows are separate queries sharing one condition. If
    // the name match lived only in one of them, "1 total" would sit above
    // two rows, or the reverse.
    const result = await service.list(COMPANY_ID, query('makerspace'));
    expect(result.total).toBe(result.data.length);
    expect(result.total).toBe(1);
  });

  it('still finds orders by order number and by customer PO', async () => {
    expect((await service.list(COMPANY_ID, query('BOB-0002'))).data.map((o) => o.orderNumber)).toEqual([
      'TEST-BOB-0002',
    ]);
    expect((await service.list(COMPANY_ID, query('PO-ALPHA'))).data.map((o) => o.orderNumber)).toEqual([
      'TEST-ALICE-0001',
    ]);
  });

  it('returns nothing for a name that matches no customer', async () => {
    const result = await service.list(COMPANY_ID, query('nobody-by-this-name'));
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe('order detail — customer name', () => {
  it('returns the customer name at the top level', async () => {
    const order = await service.getById(aliceOrderId, COMPANY_ID);
    expect(order?.customerName).toBe('Alice Printworks');
  });

  it('returns nothing for an order that does not exist', async () => {
    const order = await service.getById('00000000-0000-4000-8000-000000000000', COMPANY_ID);
    expect(order).toBeUndefined();
  });
});
