/**
 * Pick notes against a real database: created, kept current, re-created on
 * demand, and the order.created event that triggers them for new orders.
 *
 * The property that matters is that nobody can open an out-of-date list, so
 * the tests change an order behind the note's back and check what is served.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  customerDeliveryAddresses,
  customerOrders,
  customers,
  domainEvents,
  orderLines,
  orderNotes,
  pickNotes,
  products,
  stockItems,
  warehouses,
} from '../../db/schema/index.js';
import { wipeCompany } from '../../../test/fixtures/stock.js';
import { OrderService } from '../orders/order.service.js';
import type { CreateOrderInput } from '../orders/order.schema.js';
import { PickNoteService } from './pick-note.service.js';

const COMPANY_ID = '55555555-5555-4555-8555-555555555555';

let dir: string;
let customerId: string;
let addressId: string;
let brownId: string;
let whiteId: string;
let seq = 0;

async function makeOrder(lines: Array<{ productId: string; quantity: number; fulfilmentSource?: 'WAREHOUSE' | 'SUPPLIER' }>) {
  const db = getDb();
  seq++;
  const [order] = await db
    .insert(customerOrders)
    .values({
      companyId: COMPANY_ID,
      orderNumber: `TEST-PICK-${seq}`,
      customerId,
      deliveryAddressId: addressId,
      orderDate: '2026-09-11',
    })
    .returning();
  for (const l of lines) await addLine(order!.id, l.productId, l.quantity, l.fulfilmentSource);
  return order!.id;
}

async function addLine(orderId: string, productId: string, quantity: number, fulfilmentSource: 'WAREHOUSE' | 'SUPPLIER' = 'WAREHOUSE') {
  await getDb().insert(orderLines).values({
    orderId,
    productId,
    quantity,
    pricePerUnit: '12.28',
    lineTotal: (12.28 * quantity).toFixed(2),
    fulfilmentSource,
  });
}

const filesInDir = async () => (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.pdf'));
const rowFor = async (orderId: string) =>
  (await getDb().select().from(pickNotes).where(eq(pickNotes.orderId, orderId)))[0]!;

async function cleanup() {
  const db = getDb();
  const orders = await db.select({ id: customerOrders.id }).from(customerOrders).where(eq(customerOrders.companyId, COMPANY_ID));
  const ids = orders.map((o) => o.id);
  if (ids.length > 0) await db.delete(orderNotes).where(inArray(orderNotes.orderId, ids));
  await db.delete(pickNotes).where(eq(pickNotes.companyId, COMPANY_ID));
  await db.delete(domainEvents).where(eq(domainEvents.companyId, COMPANY_ID));
  await wipeCompany(COMPANY_ID);
  const cs = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, COMPANY_ID));
  if (cs.length > 0) {
    const customerIds = cs.map((c) => c.id);
    await db.delete(customerDeliveryAddresses).where(inArray(customerDeliveryAddresses.customerId, customerIds));
    await db.delete(customers).where(inArray(customers.id, customerIds));
  }
}

beforeAll(async () => {
  await cleanup();
  dir = await mkdtemp(join(tmpdir(), 'smmta-pick-notes-test-'));
  const db = getDb();
  const [cust] = await db
    .insert(customers)
    .values({ companyId: COMPANY_ID, name: 'Roger Test', email: 'roger@picknotes.invalid' })
    .returning();
  customerId = cust!.id;
  const [addr] = await db
    .insert(customerDeliveryAddresses)
    .values({ customerId, contactName: 'Roger Test', line1: 'Close Cottage', city: 'Stoke-on-Trent', postCode: 'ST7 3PL', country: 'GB' })
    .returning();
  addressId = addr!.id;
  const [brown] = await db
    .insert(products)
    .values({ companyId: COMPANY_ID, name: 'Landau PLA Basic 1.75mm 1kg — Brown', stockCode: 'TEST-PICK-BROWN' })
    .returning();
  const [white] = await db
    .insert(products)
    .values({ companyId: COMPANY_ID, name: 'Landau PLA Basic 1.75mm 1kg — White', stockCode: 'TEST-PICK-WHITE' })
    .returning();
  brownId = brown!.id;
  whiteId = white!.id;
  // Located stock, so the location lookup runs against real rows.
  const [wh] = await db.insert(warehouses).values({ companyId: COMPANY_ID, name: 'Pick test warehouse' }).returning();
  await db.insert(stockItems).values({
    companyId: COMPANY_ID,
    productId: brownId,
    warehouseId: wh!.id,
    locationIsle: 'A',
    locationShelf: '3',
    locationBin: '12',
    status: 'IN_STOCK',
  });
});

afterAll(async () => {
  await cleanup();
  await rm(dir, { recursive: true, force: true });
  await closeDatabase();
});

const service = () => new PickNoteService({ dir });

describe('PickNoteService', () => {
  it('creates the pick note and stores the PDF with the order', async () => {
    const orderId = await makeOrder([{ productId: brownId, quantity: 2 }, { productId: whiteId, quantity: 1 }]);
    const note = await service().generate(orderId, COMPANY_ID);

    expect(note).toMatchObject({ status: 'CREATED', lineCount: 2, unitCount: 3, hasFile: true, isStale: false });
    const file = await service().readFile(orderId, COMPANY_ID);
    expect(file?.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(file?.filename).toMatch(/^pick-note-TEST-PICK-\d+\.pdf$/);
  });

  it('does not re-create a note for an order that has not changed', async () => {
    const orderId = await makeOrder([{ productId: brownId, quantity: 1 }]);
    await service().generate(orderId, COMPANY_ID);
    const first = await rowFor(orderId);
    await service().generate(orderId, COMPANY_ID);
    expect((await rowFor(orderId)).filePath).toBe(first.filePath);
  });

  it('never serves an out-of-date list: an added item makes the note stale, and opening it re-creates it', async () => {
    const orderId = await makeOrder([{ productId: brownId, quantity: 1 }]);
    const svc = service();
    await svc.generate(orderId, COMPANY_ID);
    const before = await rowFor(orderId);

    await addLine(orderId, whiteId, 4);
    expect((await svc.getForOrder(orderId, COMPANY_ID))?.isStale).toBe(true);

    const file = await svc.readFile(orderId, COMPANY_ID);
    expect(file).not.toBeNull();
    const after = await rowFor(orderId);
    expect(after.filePath).not.toBe(before.filePath);
    expect(after.lineCount).toBe(2);
    expect(after.unitCount).toBe(5);
    expect(await filesInDir()).not.toContain(before.filePath);
    expect((await svc.getForOrder(orderId, COMPANY_ID))?.isStale).toBe(false);
  });

  it('treats a new picking instruction as a change', async () => {
    const orderId = await makeOrder([{ productId: brownId, quantity: 1 }]);
    const svc = service();
    await svc.generate(orderId, COMPANY_ID);
    await getDb().insert(orderNotes).values({ orderId, note: 'Gift wrap please', isPickingNote: true });
    expect((await svc.getForOrder(orderId, COMPANY_ID))?.isStale).toBe(true);
  });

  it('re-creates on demand even when nothing has changed, keeping one file', async () => {
    const orderId = await makeOrder([{ productId: brownId, quantity: 1 }]);
    const svc = service();
    await svc.generate(orderId, COMPANY_ID);
    const first = await rowFor(orderId);
    await svc.generate(orderId, COMPANY_ID, { force: true });
    const second = await rowFor(orderId);
    expect(second.filePath).not.toBe(first.filePath);
    expect(await filesInDir()).not.toContain(first.filePath);
  });

  it('records an order with nothing to pick as failed, without a file', async () => {
    const orderId = await makeOrder([{ productId: brownId, quantity: 1, fulfilmentSource: 'SUPPLIER' }]);
    const note = await service().generate(orderId, COMPANY_ID);
    expect(note.status).toBe('FAILED');
    expect(note.hasFile).toBe(false);
    expect(note.errorMessage).toMatch(/ships direct from a supplier/);
    expect(await service().readFile(orderId, COMPANY_ID)).toBeNull();
  });
});

describe('OrderService.create', () => {
  it('emits order.created for the new order, which is what gets it a pick note', async () => {
    const order = await new OrderService().create(COMPANY_ID, {
      customerId,
      deliveryAddressId: addressId,
      orderDate: '2026-09-11',
      currencyCode: 'GBP',
      sourceChannel: 'MANUAL',
      lines: [{ productId: brownId, quantity: 2, pricePerUnit: 10, taxRate: 20 }],
    } as CreateOrderInput);

    const events = await getDb()
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.companyId, COMPANY_ID), eq(domainEvents.eventType, 'order.created')));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ orderId: order!.id, source: 'MANUAL' });
  });
});
