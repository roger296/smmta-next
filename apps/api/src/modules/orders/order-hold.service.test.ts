/**
 * Order holds, against a real database: what a hold stops, what releasing it
 * starts, and that a hold check can hold a new order as it is created.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { customerDeliveryAddresses, customers, domainEvents, orderHolds, products, warehouses } from '../../db/schema/index.js';
import { wipeCompany } from '../../../test/fixtures/stock.js';
import { PickNoteService } from '../shipping/pick-note.service.js';
import { ShipOrderService } from '../shipping/ship-order.service.js';
import { ShippingLabelService } from '../shipping/shipping-label.service.js';
import {
  MANUAL_HOLDER,
  OrderHeldError,
  OrderHoldError,
  OrderHoldService,
  clearOrderHoldChecks,
  registerOrderHoldCheck,
} from './order-hold.service.js';
import { OrderService } from './order.service.js';

const COMPANY_ID = '66666666-6666-4666-8666-666666666666';

let dir: string;
let customerId: string;
let productId: string;
let heldWarehouseId: string;
let freeWarehouseId: string;

const holds = new OrderHoldService();
const orders = new OrderService();

const newOrder = (warehouseId: string) =>
  orders.create(COMPANY_ID, {
    customerId,
    warehouseId,
    orderDate: '2026-09-21',
    lines: [{ productId, quantity: 1, pricePerUnit: 10, taxRate: 20 }],
  } as Parameters<OrderService['create']>[1]);

const eventsFor = async (orderId: string) =>
  (await getDb().select().from(domainEvents).where(and(eq(domainEvents.companyId, COMPANY_ID), eq(domainEvents.aggregateId, orderId)))).map(
    (e) => e.eventType,
  );

async function cleanup() {
  const db = getDb();
  await db.delete(orderHolds).where(eq(orderHolds.companyId, COMPANY_ID));
  await db.delete(domainEvents).where(eq(domainEvents.companyId, COMPANY_ID));
  await wipeCompany(COMPANY_ID);
  const cs = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, COMPANY_ID));
  if (cs.length > 0) {
    await db.delete(customerDeliveryAddresses).where(inArray(customerDeliveryAddresses.customerId, cs.map((c) => c.id)));
    await db.delete(customers).where(eq(customers.companyId, COMPANY_ID));
  }
}

beforeAll(async () => {
  await cleanup();
  dir = await mkdtemp(join(tmpdir(), 'smmta-hold-test-'));
  const db = getDb();
  const [cust] = await db.insert(customers).values({ companyId: COMPANY_ID, name: 'Hold Test', email: 'hold@test.invalid' }).returning();
  customerId = cust!.id;
  const [product] = await db.insert(products).values({ companyId: COMPANY_ID, name: 'Hold test product', stockCode: 'HOLD-TEST' }).returning();
  productId = product!.id;
  const [a] = await db.insert(warehouses).values({ companyId: COMPANY_ID, name: 'Signs off its orders' }).returning();
  const [b] = await db.insert(warehouses).values({ companyId: COMPANY_ID, name: 'Does not' }).returning();
  heldWarehouseId = a!.id;
  freeWarehouseId = b!.id;
});

afterEach(() => clearOrderHoldChecks());

afterAll(async () => {
  await cleanup();
  await rm(dir, { recursive: true, force: true });
  await closeDatabase();
});

describe('a manual hold', () => {
  it('stops the pick note, the label and shipping, and says why', async () => {
    const order = await newOrder(freeWarehouseId);
    await holds.place(order!.id, COMPANY_ID, MANUAL_HOLDER, 'Customer asked us to wait', { userId: null });

    const pickNotes = new PickNoteService({ dir: join(dir, 'pick-notes') });
    const labels = new ShippingLabelService({ labelsDir: dir, enabled: false });
    await expect(pickNotes.generate(order!.id, COMPANY_ID)).rejects.toThrow(OrderHeldError);
    await expect(labels.requestLabel(order!.id, COMPANY_ID)).rejects.toThrow(/Customer asked us to wait/);

    const readiness = await new ShipOrderService({ labels, pickNotes }).readiness(order!.id, COMPANY_ID);
    expect(readiness).toMatchObject({ ready: false, held: true });
    expect(readiness.reasons).toContain('On hold: Customer asked us to wait');
    // It asks for the hold to be lifted, not for documents it cannot have.
    expect(readiness.reasons.join(' ')).not.toMatch(/pick note|shipping label/);
  });

  it('shows on the order and in the list, and can be filtered on', async () => {
    const held = await newOrder(freeWarehouseId);
    const free = await newOrder(freeWarehouseId);
    await holds.place(held!.id, COMPANY_ID, MANUAL_HOLDER, 'Awaiting payment');

    expect((await orders.getById(held!.id, COMPANY_ID))!.holds.map((h) => h.reason)).toEqual(['Awaiting payment']);
    const onlyHeld = await orders.list(COMPANY_ID, { page: 1, pageSize: 100, held: true } as Parameters<OrderService['list']>[1]);
    expect(onlyHeld.data.map((o) => o.id)).toContain(held!.id);
    expect(onlyHeld.data.map((o) => o.id)).not.toContain(free!.id);
    const notHeld = await orders.list(COMPANY_ID, { page: 1, pageSize: 100, held: false } as Parameters<OrderService['list']>[1]);
    expect(notHeld.data.map((o) => o.id)).toContain(free!.id);
    expect(notHeld.data.map((o) => o.id)).not.toContain(held!.id);
  });

  it('emits order.held once and order.released when the last hold goes', async () => {
    const order = await newOrder(freeWarehouseId);
    await holds.place(order!.id, COMPANY_ID, MANUAL_HOLDER, 'First reason');
    await holds.place(order!.id, COMPANY_ID, MANUAL_HOLDER, 'Changed my mind about why');
    await holds.place(order!.id, COMPANY_ID, 'some-extension', 'Needs sign-off');
    expect((await holds.liveFor(order!.id)).map((h) => h.reason)).toEqual(['Changed my mind about why', 'Needs sign-off']);

    expect(await holds.release(order!.id, COMPANY_ID, MANUAL_HOLDER)).toEqual({ released: true, free: false });
    expect(await eventsFor(order!.id)).not.toContain('order.released');
    expect(await holds.release(order!.id, COMPANY_ID, 'some-extension')).toEqual({ released: true, free: true });
    expect(await holds.release(order!.id, COMPANY_ID, 'some-extension')).toEqual({ released: false, free: true });

    const events = await eventsFor(order!.id);
    expect(events.filter((e) => e === 'order.held')).toHaveLength(1);
    expect(events.filter((e) => e === 'order.released')).toHaveLength(1);
    expect(await holds.historyFor(order!.id, COMPANY_ID)).toHaveLength(2);
  });

  it('needs a reason', async () => {
    const order = await newOrder(freeWarehouseId);
    await expect(holds.place(order!.id, COMPANY_ID, MANUAL_HOLDER, '   ')).rejects.toThrow(OrderHoldError);
  });
});

describe('a hold check', () => {
  it('holds a new order as it is created, by whatever it chooses to look at', async () => {
    registerOrderHoldCheck(async (_tx, order) =>
      order.warehouseId === heldWarehouseId ? { holderKey: 'warehouse-sign-off', reason: 'Waiting for sign-off' } : null,
    );
    const held = await newOrder(heldWarehouseId);
    const free = await newOrder(freeWarehouseId);

    expect((await holds.liveFor(held!.id)).map((h) => `${h.holderKey}: ${h.reason}`)).toEqual(['warehouse-sign-off: Waiting for sign-off']);
    expect(await holds.isHeld(free!.id)).toBe(false);
    // Held before order.created, so the pick note that event asks for is refused.
    expect(await eventsFor(held!.id)).toEqual(expect.arrayContaining(['order.held', 'order.created']));
  });

  it('that throws stops the order being created at all', async () => {
    registerOrderHoldCheck(async () => {
      throw new Error('settings unreadable');
    });
    await expect(newOrder(freeWarehouseId)).rejects.toThrow('settings unreadable');
  });
});
