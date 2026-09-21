/**
 * Scanning serial-tracked units onto an order, against a real database: the
 * record ends up matching the box, no order is left short, and an order with
 * serial-tracked units cannot ship until they are all scanned.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { customerDeliveryAddresses, customerOrders, customers, domainEvents, orderLines, products, stockItems, warehouses } from '../../db/schema/index.js';
import { wipeCompany } from '../../../test/fixtures/stock.js';
import { StockItemService } from '../products/stock-item.service.js';
import { PickNoteService } from './pick-note.service.js';
import { SerialScanError, SerialScanService } from './serial-scan.service.js';
import { ShipOrderService } from './ship-order.service.js';
import { ShippingLabelService } from './shipping-label.service.js';

const COMPANY_ID = '88888888-8888-4888-8888-888888888888';

let dir: string;
let customerId: string;
let warehouseId: string;
let inverterId: string;
let cableId: string;
let seq = 0;

const scans = new SerialScanService();

/** An order for `inverters` serial-tracked units and one cable, with the oldest stock allocated to it. */
async function makeOrder(inverters: number, allocate = true) {
  const db = getDb();
  seq++;
  const [order] = await db
    .insert(customerOrders)
    .values({ companyId: COMPANY_ID, orderNumber: `TEST-SCAN-${seq}`, customerId, warehouseId, orderDate: '2026-09-21', status: 'CONFIRMED', sourceChannel: 'MANUAL', grandTotal: '0' })
    .returning();
  await db.insert(orderLines).values([
    { orderId: order!.id, productId: inverterId, quantity: inverters, pricePerUnit: '400.00', lineTotal: (400 * inverters).toFixed(2) },
    { orderId: order!.id, productId: cableId, quantity: 1, pricePerUnit: '5.00', lineTotal: '5.00' },
  ]);
  if (allocate) {
    const stock = new StockItemService();
    await stock.allocateToOrder(COMPANY_ID, order!.id, inverterId, warehouseId, inverters);
    await stock.allocateToOrder(COMPANY_ID, order!.id, cableId, warehouseId, 1);
  }
  return order!.id;
}

const unitsOn = async (orderId: string) =>
  (await getDb().select().from(stockItems).where(and(eq(stockItems.salesOrderId, orderId), eq(stockItems.productId, inverterId))))
    .map((u) => `${u.serialNumber}${u.scannedAt ? '*' : ''}`)
    .sort();

const statusOf = async (serial: string) => {
  const [u] = await getDb().select().from(stockItems).where(and(eq(stockItems.companyId, COMPANY_ID), eq(stockItems.serialNumber, serial)));
  return `${u!.status}:${u!.salesOrderId ? 'order' : 'free'}`;
};

async function cleanup() {
  const db = getDb();
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
  dir = await mkdtemp(join(tmpdir(), 'smmta-scan-test-'));
  const db = getDb();
  const [cust] = await db.insert(customers).values({ companyId: COMPANY_ID, name: 'Scan Test', email: 'scan@test.invalid' }).returning();
  customerId = cust!.id;
  const [wh] = await db.insert(warehouses).values({ companyId: COMPANY_ID, name: 'Scan test warehouse' }).returning();
  warehouseId = wh!.id;
  const [inverter] = await db.insert(products).values({ companyId: COMPANY_ID, name: 'Scan test inverter', stockCode: 'SCAN-INV', requireSerialNumber: true }).returning();
  const [cable] = await db.insert(products).values({ companyId: COMPANY_ID, name: 'Scan test cable', stockCode: 'SCAN-CBL' }).returning();
  inverterId = inverter!.id;
  cableId = cable!.id;
  // Oldest first: INV-01 is what the system will allocate first.
  for (let i = 1; i <= 12; i++) {
    await db.insert(stockItems).values({
      companyId: COMPANY_ID,
      productId: inverterId,
      warehouseId,
      serialNumber: `INV-${String(i).padStart(2, '0')}`,
      createdAt: new Date(Date.UTC(2026, 0, i)),
    });
  }
  for (let i = 0; i < 12; i++) await db.insert(stockItems).values({ companyId: COMPANY_ID, productId: cableId, warehouseId });
});

afterAll(async () => {
  await cleanup();
  await rm(dir, { recursive: true, force: true });
  await closeDatabase();
});

describe('scanning a unit onto an order', () => {
  it('marks the allocated unit scanned, and says how far along the order is', async () => {
    const orderId = await makeOrder(2); // INV-01, INV-02
    expect(await scans.progress(orderId, COMPANY_ID)).toMatchObject({ required: true, complete: false });

    const first = await scans.scan(orderId, COMPANY_ID, ' inv-01 ');
    expect(first).toMatchObject({ outcome: 'scanned', productName: 'Scan test inverter' });
    expect(first.progress.lines).toHaveLength(1); // the cable is not serial-tracked, so is not asked for
    expect(first.progress.lines[0]).toMatchObject({ needed: 2 });
    expect(first.progress.lines[0]!.scanned.map((s) => s.serialNumber)).toEqual(['INV-01']);

    await expect(scans.scan(orderId, COMPANY_ID, 'INV-01')).rejects.toThrow(/already been scanned onto this order/);
    expect((await scans.scan(orderId, COMPANY_ID, 'INV-02')).progress.complete).toBe(true);
  });

  it('takes a unit from free stock in place of the one allocated, which goes back to stock', async () => {
    const orderId = await makeOrder(1); // INV-03
    const result = await scans.scan(orderId, COMPANY_ID, 'INV-10');
    expect(result.outcome).toBe('swapped-from-stock');
    expect(result.message).toMatch(/replaces INV-03/);
    expect(await unitsOn(orderId)).toEqual(['INV-10*']);
    expect(await statusOf('INV-03')).toBe('IN_STOCK:free');
  });

  it('swaps with another order, leaving neither short', async () => {
    const mine = await makeOrder(1); // INV-03 again (freed above)
    const theirs = await makeOrder(1); // INV-04
    const result = await scans.scan(mine, COMPANY_ID, 'INV-04');
    expect(result.outcome).toBe('swapped-with-order');
    expect(await unitsOn(mine)).toEqual(['INV-04*']);
    expect(await unitsOn(theirs)).toEqual(['INV-03']);

    // Once scanned onto an order a unit stays there.
    await expect(scans.scan(theirs, COMPANY_ID, 'INV-04')).rejects.toThrow(/scanned onto another order/);
  });

  it('never gives an order more units than it asked for', async () => {
    const orderId = await makeOrder(1); // INV-05
    await scans.scan(orderId, COMPANY_ID, 'INV-05');
    await expect(scans.scan(orderId, COMPANY_ID, 'INV-11')).rejects.toThrow(/Every unit .* has been scanned already/);
    expect(await statusOf('INV-11')).toBe('IN_STOCK:free');
  });

  it('allocates as it scans when the order had no stock allocated', async () => {
    const orderId = await makeOrder(1, false);
    expect((await scans.scan(orderId, COMPANY_ID, 'INV-11')).outcome).toBe('added');
    expect(await unitsOn(orderId)).toEqual(['INV-11*']);
  });

  it('refuses what cannot go in the box, saying why', async () => {
    const orderId = await makeOrder(1); // INV-06
    await expect(scans.scan(orderId, COMPANY_ID, 'NOPE-1')).rejects.toThrow(/not a serial number in the system/);
    await expect(scans.scan(orderId, COMPANY_ID, '  ')).rejects.toThrow(SerialScanError);

    await getDb().update(stockItems).set({ status: 'SOLD' }).where(and(eq(stockItems.companyId, COMPANY_ID), eq(stockItems.serialNumber, 'INV-12')));
    await expect(scans.scan(orderId, COMPANY_ID, 'INV-12')).rejects.toThrow(/already been sold/);
  });

  it('can take a scan back', async () => {
    const orderId = await makeOrder(1); // INV-07
    const scanned = await scans.scan(orderId, COMPANY_ID, 'INV-07');
    const after = await scans.unscan(orderId, COMPANY_ID, scanned.progress.lines[0]!.scanned[0]!.stockItemId);
    expect(after.complete).toBe(false);
    expect(await unitsOn(orderId)).toEqual(['INV-07']);
  });
});

describe('shipping', () => {
  it('waits for every serial-tracked unit to be scanned', async () => {
    const orderId = await makeOrder(2); // INV-08, INV-09
    const pickNotes = new PickNoteService({ dir: join(dir, 'pick-notes') });
    const ship = new ShipOrderService({ labels: new ShippingLabelService({ labelsDir: dir, enabled: false }), pickNotes });
    await pickNotes.generate(orderId, COMPANY_ID);
    await ship.setOwnLabel(orderId, COMPANY_ID, { courierName: 'DHL', trackingNumber: 'T1' });

    const before = await ship.readiness(orderId, COMPANY_ID);
    expect(before).toMatchObject({ ready: false, serialsScanned: false });
    expect(before.reasons).toEqual(['Scan serial numbers: 0 of 2 units of SCAN-INV scanned.']);

    await scans.scan(orderId, COMPANY_ID, 'INV-08');
    expect((await ship.readiness(orderId, COMPANY_ID)).reasons).toEqual(['Scan serial numbers: 1 of 2 units of SCAN-INV scanned.']);
    await scans.scan(orderId, COMPANY_ID, 'INV-09');
    expect(await ship.readiness(orderId, COMPANY_ID)).toMatchObject({ ready: true, serialsScanned: true });
  });

  it('asks nothing of an order with no serial-tracked products', async () => {
    const db = getDb();
    seq++;
    const [order] = await db
      .insert(customerOrders)
      .values({ companyId: COMPANY_ID, orderNumber: `TEST-SCAN-${seq}`, customerId, warehouseId, orderDate: '2026-09-21', status: 'CONFIRMED', sourceChannel: 'MANUAL', grandTotal: '0' })
      .returning();
    await db.insert(orderLines).values({ orderId: order!.id, productId: cableId, quantity: 1, pricePerUnit: '5.00', lineTotal: '5.00' });
    expect(await scans.progress(order!.id, COMPANY_ID)).toMatchObject({ required: false, complete: true, lines: [] });
    await expect(scans.scan(order!.id, COMPANY_ID, 'INV-01')).rejects.toThrow(/Nothing on this order/);
  });
});
