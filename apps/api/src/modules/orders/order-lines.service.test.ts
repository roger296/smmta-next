/**
 * Editing an open order's lines, against a real database: totals follow,
 * stock the order no longer needs goes back (scanned units last), the status
 * follows for an allocated order, and closed or paid orders are refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { customers, domainEvents, invoices, orderLines, products, stockItems, warehouses, customerOrders } from '../../db/schema/index.js';
import { wipeCompany } from '../../../test/fixtures/stock.js';
import { OrderLineError, OrderLinesService } from './order-lines.service.js';
import { OrderService } from './order.service.js';

const COMPANY_ID = '99999999-9999-4999-8999-999999999991';

let customerId: string;
let warehouseId: string;
let widgetId: string;
let gadgetId: string;

const orders = new OrderService();
const lines = new OrderLinesService();

async function makeOrder(widgets = 2) {
  const order = await orders.create(COMPANY_ID, {
    customerId,
    warehouseId,
    orderDate: '2026-09-23',
    deliveryCharge: 5,
    lines: [{ productId: widgetId, quantity: widgets, pricePerUnit: 10, taxRate: 20 }],
  } as Parameters<OrderService['create']>[1]);
  return order!;
}

const openLines = async (orderId: string) =>
  (await getDb().select().from(orderLines).where(eq(orderLines.orderId, orderId))).filter((l) => !l.deletedAt);
const orderRow = async (orderId: string) => (await getDb().select().from(customerOrders).where(eq(customerOrders.id, orderId)))[0]!;
const heldBy = async (orderId: string) =>
  getDb().select().from(stockItems).where(and(eq(stockItems.salesOrderId, orderId), eq(stockItems.status, 'ALLOCATED')));
const events = async (orderId: string, type: string) =>
  (await getDb().select().from(domainEvents).where(and(eq(domainEvents.aggregateId, orderId), eq(domainEvents.eventType, type as never)))).length;

async function cleanup() {
  const db = getDb();
  await db.delete(invoices).where(eq(invoices.companyId, COMPANY_ID));
  await db.delete(domainEvents).where(eq(domainEvents.companyId, COMPANY_ID));
  await wipeCompany(COMPANY_ID);
  await db.delete(customers).where(eq(customers.companyId, COMPANY_ID));
}

beforeAll(async () => {
  await cleanup();
  const db = getDb();
  const [cust] = await db.insert(customers).values({ companyId: COMPANY_ID, name: 'Line Test', email: 'lines@test.invalid' }).returning();
  customerId = cust!.id;
  const [wh] = await db.insert(warehouses).values({ companyId: COMPANY_ID, name: 'Line test warehouse' }).returning();
  warehouseId = wh!.id;
  const [widget] = await db.insert(products).values({ companyId: COMPANY_ID, name: 'Widget', stockCode: 'LINE-WIDGET' }).returning();
  const [gadget] = await db.insert(products).values({ companyId: COMPANY_ID, name: 'Gadget', stockCode: 'LINE-GADGET' }).returning();
  widgetId = widget!.id;
  gadgetId = gadget!.id;
  for (let i = 0; i < 20; i++) await db.insert(stockItems).values({ companyId: COMPANY_ID, productId: widgetId, warehouseId });
  for (let i = 0; i < 5; i++) await db.insert(stockItems).values({ companyId: COMPANY_ID, productId: gadgetId, warehouseId });
});

afterAll(async () => {
  await cleanup();
  await closeDatabase();
});


describe('changing a line', () => {
  it('recomputes the line and the order totals', async () => {
    const order = await makeOrder(2); // 2 × £10 + 20% + £5 delivery = £29
    expect(order.grandTotal).toBe('29.00');
    const [line] = await openLines(order.id);

    const result = await lines.updateLine(order.id, COMPANY_ID, line!.id, { quantity: 3, pricePerUnit: 12.5 });
    expect(result).toMatchObject({ orderTotal: '37.50', taxTotal: '7.50', grandTotal: '50.00', released: 0 });
    const [after] = await openLines(order.id);
    expect(after).toMatchObject({ quantity: 3, pricePerUnit: '12.50', lineTotal: '37.50', taxValue: '7.50', remainingQuantity: 3 });
    expect(await events(order.id, 'order.lines_changed')).toBe(1);
  });

  it('keeps the price when only the quantity changes, and the other way round', async () => {
    const order = await makeOrder(2);
    const [line] = await openLines(order.id);
    await lines.updateLine(order.id, COMPANY_ID, line!.id, { quantity: 4 });
    expect((await openLines(order.id))[0]).toMatchObject({ quantity: 4, pricePerUnit: '10.00', lineTotal: '40.00' });
    await lines.updateLine(order.id, COMPANY_ID, line!.id, { pricePerUnit: 9 });
    expect((await openLines(order.id))[0]).toMatchObject({ quantity: 4, pricePerUnit: '9.00', lineTotal: '36.00' });
  });

  it('refuses a zero quantity, a negative price, and nothing at all', async () => {
    const order = await makeOrder(2);
    const [line] = await openLines(order.id);
    await expect(lines.updateLine(order.id, COMPANY_ID, line!.id, { quantity: 0 })).rejects.toThrow(OrderLineError);
    await expect(lines.updateLine(order.id, COMPANY_ID, line!.id, { pricePerUnit: -1 })).rejects.toThrow(OrderLineError);
    await expect(lines.updateLine(order.id, COMPANY_ID, line!.id, {})).rejects.toThrow(/Nothing to change/);
  });
});

describe('an allocated order', () => {
  it('gives back the units it no longer needs when a quantity drops, scanned units last', async () => {
    const order = await makeOrder(3);
    await orders.allocateStock(order.id, COMPANY_ID, warehouseId);
    const held = await heldBy(order.id);
    expect(held).toHaveLength(3);
    // The dispatcher has scanned one of them into the box already.
    await getDb().update(stockItems).set({ scannedAt: new Date() }).where(eq(stockItems.id, held[0]!.id));

    const [line] = await openLines(order.id);
    const result = await lines.updateLine(order.id, COMPANY_ID, line!.id, { quantity: 1 });
    expect(result).toMatchObject({ released: 2, status: 'ALLOCATED' });
    const kept = await heldBy(order.id);
    expect(kept.map((u) => u.id)).toEqual([held[0]!.id]);
  });

  it('becomes part allocated when a quantity rises, and allocated again when stock is found', async () => {
    const order = await makeOrder(2);
    await orders.allocateStock(order.id, COMPANY_ID, warehouseId);
    const [line] = await openLines(order.id);
    expect((await lines.updateLine(order.id, COMPANY_ID, line!.id, { quantity: 3 })).status).toBe('PARTIALLY_ALLOCATED');
    expect((await orderRow(order.id)).status).toBe('PARTIALLY_ALLOCATED');
    expect(await events(order.id, 'order.allocated')).toBe(1);

    await orders.allocateStock(order.id, COMPANY_ID, warehouseId);
    expect((await orderRow(order.id)).status).toBe('ALLOCATED');
    expect(await heldBy(order.id)).toHaveLength(3);

    // Dropping back to what is held makes it allocated by the edit alone.
    await lines.updateLine(order.id, COMPANY_ID, line!.id, { quantity: 4 });
    expect((await lines.updateLine(order.id, COMPANY_ID, line!.id, { quantity: 3 })).status).toBe('ALLOCATED');
    expect(await events(order.id, 'order.allocated')).toBe(3);
  });

  it('leaves an order that was never allocated as it is', async () => {
    const order = await makeOrder(2);
    const [line] = await openLines(order.id);
    expect((await lines.updateLine(order.id, COMPANY_ID, line!.id, { quantity: 5 })).status).toBe('CONFIRMED');
  });
});

describe('adding and removing lines', () => {
  it('adds a line with its tax, and refuses an unknown product', async () => {
    const order = await makeOrder(2);
    const result = await lines.addLine(order.id, COMPANY_ID, { productId: gadgetId, quantity: 1, pricePerUnit: 100, taxRate: 0 });
    expect(result).toMatchObject({ orderTotal: '120.00', taxTotal: '4.00', grandTotal: '129.00' });
    const added = (await openLines(order.id)).find((l) => l.productId === gadgetId);
    expect(added).toMatchObject({ quantity: 1, taxRate: 0, taxValue: '0.00', taxName: 'VAT 0%', remainingQuantity: 1 });
    await expect(
      lines.addLine(order.id, COMPANY_ID, { productId: '00000000-0000-4000-8000-000000000000', quantity: 1, pricePerUnit: 1 }),
    ).rejects.toThrow(/Product not found/);
  });

  it('removes a line and releases its stock, but never the last line', async () => {
    const order = await makeOrder(2);
    await lines.addLine(order.id, COMPANY_ID, { productId: gadgetId, quantity: 2, pricePerUnit: 50 });
    await orders.allocateStock(order.id, COMPANY_ID, warehouseId);
    expect(await heldBy(order.id)).toHaveLength(4);

    const gadgetLine = (await openLines(order.id)).find((l) => l.productId === gadgetId)!;
    const result = await lines.removeLine(order.id, COMPANY_ID, gadgetLine.id);
    expect(result).toMatchObject({ released: 2, status: 'ALLOCATED', orderTotal: '20.00', grandTotal: '29.00' });
    expect(await openLines(order.id)).toHaveLength(1);
    expect(await heldBy(order.id)).toHaveLength(2);

    const [last] = await openLines(order.id);
    await expect(lines.removeLine(order.id, COMPANY_ID, last!.id)).rejects.toThrow(/at least one line/);
  });
});

describe('orders that cannot be edited', () => {
  it('a shipped, cancelled, invoiced or online-paid order', async () => {
    const db = getDb();
    const shipped = await makeOrder(1);
    await db.update(customerOrders).set({ status: 'SHIPPED' }).where(eq(customerOrders.id, shipped.id));
    const [l1] = await openLines(shipped.id);
    await expect(lines.updateLine(shipped.id, COMPANY_ID, l1!.id, { quantity: 2 })).rejects.toThrow(/shipped/);

    const cancelled = await makeOrder(1);
    await db.update(customerOrders).set({ status: 'CANCELLED' }).where(eq(customerOrders.id, cancelled.id));
    await expect(lines.addLine(cancelled.id, COMPANY_ID, { productId: gadgetId, quantity: 1, pricePerUnit: 1 })).rejects.toThrow(/cancelled/);

    const paid = await makeOrder(1);
    await db.update(customerOrders).set({ integrationMetadata: { mollie: { status: 'paid' } } }).where(eq(customerOrders.id, paid.id));
    const [l3] = await openLines(paid.id);
    await expect(lines.updateLine(paid.id, COMPANY_ID, l3!.id, { quantity: 2 })).rejects.toThrow(/paid for online/);

    const invoiced = await makeOrder(1);
    await db.insert(invoices).values({
      companyId: COMPANY_ID,
      orderId: invoiced.id,
      customerId,
      grandTotal: '17.00',
      amountOutstanding: '17.00',
      dateOfInvoice: '2026-09-23',
    });
    const [l4] = await openLines(invoiced.id);
    await expect(lines.updateLine(invoiced.id, COMPANY_ID, l4!.id, { quantity: 2 })).rejects.toThrow(/invoiced/);
  });

  it('a line on some other order', async () => {
    const a = await makeOrder(1);
    const b = await makeOrder(1);
    const [lineOfB] = await openLines(b.id);
    await expect(lines.updateLine(a.id, COMPANY_ID, lineOfB!.id, { quantity: 2 })).rejects.toThrow(/not found on this order/);
  });
});

