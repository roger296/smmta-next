/**
 * Inbound-shipment + presale-pool tests (Prompt 4, SPEC F1, §13.4).
 * Real Postgres at DATABASE_URL. Uses the singleton company (the service is
 * hardwired to it); isolates by 'INB-'-prefixed references/SKUs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  inboundShipments,
  inboundShipmentLines,
  products,
  stockItems,
  warehouses,
  pricingRules,
  domainEvents,
} from '../../db/schema/index.js';
import { InboundService, PresaleOversellError, presaleAvailable } from './inbound.service.js';

const COMPANY = getSingletonCompanyId();
const inbound = new InboundService();

let seq = 0;
const ref = () => `INB-TEST-${Date.now()}-${++seq}`;
const sku = (tag: string) => `INB-${tag}-${++seq}`;

async function eventsFor(shipmentId: string, type?: string) {
  const db = getDb();
  const conds = [eq(domainEvents.aggregateId, shipmentId)];
  if (type) conds.push(eq(domainEvents.eventType, type));
  return db.select().from(domainEvents).where(and(...conds));
}

async function makeWarehouseAndProduct(theSku: string): Promise<{ warehouseId: string; productId: string }> {
  const db = getDb();
  const [wh] = await db
    .insert(warehouses)
    .values({ companyId: COMPANY, name: 'Inbound Test WH', isDefault: false })
    .returning({ id: warehouses.id });
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: `Inbound ${theSku}`, stockCode: theSku, defaultWarehouseId: wh!.id })
    .returning({ id: products.id });
  return { warehouseId: wh!.id, productId: p!.id };
}

beforeAll(async () => {
  // Ensure a default pricing_rules row (lowStockThreshold 10) exists.
  await getDb()
    .insert(pricingRules)
    .values({ companyId: COMPANY, category: null, preorderBands: [], lowStockThreshold: 10 })
    .onConflictDoNothing();
});

afterEach(async () => {
  const db = getDb();
  const ships = await db
    .select({ id: inboundShipments.id })
    .from(inboundShipments)
    .where(like(inboundShipments.reference, 'INB-TEST-%'));
  const shipIds = ships.map((s) => s.id);
  if (shipIds.length) {
    await db.delete(inboundShipmentLines).where(inArray(inboundShipmentLines.shipmentId, shipIds));
    await db.delete(domainEvents).where(inArray(domainEvents.aggregateId, shipIds));
    await db.delete(inboundShipments).where(inArray(inboundShipments.id, shipIds));
  }
  const prods = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.companyId, COMPANY), like(products.stockCode, 'INB-%')));
  const prodIds = prods.map((p) => p.id);
  if (prodIds.length) {
    await db.delete(stockItems).where(inArray(stockItems.productId, prodIds));
    await db.delete(products).where(inArray(products.id, prodIds));
  }
  await db
    .delete(warehouses)
    .where(and(eq(warehouses.companyId, COMPANY), eq(warehouses.name, 'Inbound Test WH')));
});

afterAll(async () => {
  await closeDatabase();
});

describe('presaleAvailable arithmetic', () => {
  it('is manifested × (1 − buffer/100) − presold, floored at 0', () => {
    expect(presaleAvailable(100, 8, 0)).toBe(92);
    expect(presaleAvailable(100, 8, 90)).toBe(2);
    expect(presaleAvailable(100, 8, 92)).toBe(0);
    expect(presaleAvailable(100, 8, 200)).toBe(0); // never negative
    expect(presaleAvailable(10, 0, 0)).toBe(10);
    expect(presaleAvailable(1, 0, 0)).toBe(1);
  });
});

describe('createShipment + updateEta events', () => {
  it('emits shipment.created and shipment.eta_changed with old/new', async () => {
    const shipment = await inbound.createShipment({
      reference: ref(),
      eta: new Date('2026-09-01T00:00:00Z'),
      bufferPct: 8,
      lines: [{ sku: sku('PETG'), qtyManifested: 480 }],
    });
    expect(await eventsFor(shipment.id, 'shipment.created')).toHaveLength(1);

    const newEta = new Date('2026-09-10T00:00:00Z');
    await inbound.updateEta(shipment.id, newEta);
    const etaEvents = await eventsFor(shipment.id, 'shipment.eta_changed');
    expect(etaEvents).toHaveLength(1);
    expect(etaEvents[0]!.payload).toMatchObject({
      oldEta: '2026-09-01T00:00:00.000Z',
      newEta: '2026-09-10T00:00:00.000Z',
    });

    // No-op when unchanged: no second event.
    await inbound.updateEta(shipment.id, newEta);
    expect(await eventsFor(shipment.id, 'shipment.eta_changed')).toHaveLength(1);
  });
});

describe('presale allocation concurrency', () => {
  it('two concurrent allocations for the last unit — exactly one wins', async () => {
    const theSku = sku('LAST');
    // manifested 1, buffer 0 → presaleAvailable = 1.
    const shipment = await inbound.createShipment({
      reference: ref(),
      eta: new Date('2026-10-01T00:00:00Z'),
      bufferPct: 0,
      lines: [{ sku: theSku, qtyManifested: 1 }],
    });

    const calls = Array.from({ length: 50 }, () => inbound.allocatePresale(shipment.id, theSku, 1));
    const results = await Promise.allSettled(calls);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(49);
    expect(losses.every((l) => (l as PromiseRejectedResult).reason instanceof PresaleOversellError)).toBe(true);

    const [line] = await getDb()
      .select()
      .from(inboundShipmentLines)
      .where(eq(inboundShipmentLines.shipmentId, shipment.id));
    expect(line!.qtyPresold).toBe(1);
  });
});

describe('goods-in reconciliation', () => {
  it('short-shipment emits arrived + short_shipped + allocation_broken and bridges received stock', async () => {
    const theSku = sku('GI');
    await makeWarehouseAndProduct(theSku);
    const shipment = await inbound.createShipment({
      reference: ref(),
      eta: new Date('2026-08-01T00:00:00Z'),
      bufferPct: 0,
      lines: [{ sku: theSku, qtyManifested: 100 }],
    });
    // Presell 10 so a short receipt of 5 breaks allocation.
    await inbound.allocatePresale(shipment.id, theSku, 10);

    await inbound.goodsIn(shipment.id, [{ sku: theSku, qtyReceived: 5 }]);

    expect(await eventsFor(shipment.id, 'shipment.arrived')).toHaveLength(1);
    expect(await eventsFor(shipment.id, 'shipment.short_shipped')).toHaveLength(1);
    expect(await eventsFor(shipment.id, 'stock.allocation_broken')).toHaveLength(1);

    // 5 IN_STOCK rows bridged into the warehouse.
    const stock = await inbound.getStockAndEta(theSku);
    expect(stock.warehouse.availableQty).toBe(5);
    // Shipment now arrived → not offered as an inbound pool.
    expect(stock.inbound).toHaveLength(0);
  });
});

describe('getStockAndEta bands', () => {
  it('bands warehouse stock and lists unarrived pools with exact presale availability', async () => {
    const theSku = sku('BAND');
    const { productId, warehouseId } = await makeWarehouseAndProduct(theSku);
    const db = getDb();

    // 0 in stock → out_of_stock; one unarrived pool with buffer.
    const shipment = await inbound.createShipment({
      reference: ref(),
      eta: new Date('2026-12-01T00:00:00Z'),
      mode: 'sea',
      bufferPct: 10,
      lines: [{ sku: theSku, qtyManifested: 100 }],
    });
    let s = await inbound.getStockAndEta(theSku);
    expect(s.warehouse.band).toBe('out_of_stock');
    expect(s.inbound).toHaveLength(1);
    expect(s.inbound[0]!.presaleAvailable).toBe(90); // floor(100*0.9) − 0
    expect(s.inbound[0]!.shipmentRef).toBe(shipment.reference);

    // Add 5 units → low_stock (≤ threshold 10).
    await db.insert(stockItems).values(
      Array.from({ length: 5 }, () => ({
        companyId: COMPANY,
        productId,
        warehouseId,
        quantity: 1,
        status: 'IN_STOCK' as const,
      })),
    );
    s = await inbound.getStockAndEta(theSku);
    expect(s.warehouse.availableQty).toBe(5);
    expect(s.warehouse.band).toBe('low_stock');

    // Add 20 more (25 total) → in_stock.
    await db.insert(stockItems).values(
      Array.from({ length: 20 }, () => ({
        companyId: COMPANY,
        productId,
        warehouseId,
        quantity: 1,
        status: 'IN_STOCK' as const,
      })),
    );
    s = await inbound.getStockAndEta(theSku);
    expect(s.warehouse.band).toBe('in_stock');
  });
});
