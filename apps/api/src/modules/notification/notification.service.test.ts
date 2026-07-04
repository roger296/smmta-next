/**
 * Notification-agent tests (Prompt 11, SPEC F6, §12.4). Real Postgres; FakeLlm.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  interestFlags,
  messageDrafts,
  domainEvents,
  products,
  warehouses,
  stockItems,
  inboundShipments,
  inboundShipmentLines,
  pricingRules,
  preorderOrders,
  preorderOrderLines,
} from '../../db/schema/index.js';
import { emitDomainEvent } from '../../shared/events/emit.js';
import { NotificationService } from './notification.service.js';
import { ComposeService } from '../messaging/compose.service.js';
import { PreorderService } from '../payments/preorder.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { InboundService } from '../inbound/inbound.service.js';
import { OpenRouterService } from '../../integrations/openrouter/openrouter.service.js';
import { FakeLlm } from '../../integrations/openrouter/openrouter.fake.js';

const COMPANY = getSingletonCompanyId();
const NOW = Date.parse('2026-07-04T00:00:00Z');
const DAY = 86_400_000;
let seq = 0;
const email = () => `ntf-${Date.now()}-${++seq}@example.test`;

function notifierWith(turns: number): NotificationService {
  const fake = new FakeLlm();
  for (let i = 0; i < turns; i++) fake.enqueue({ content: JSON.stringify({ subject: 's', body: 'b' }) });
  return new NotificationService(new ComposeService(new OpenRouterService(fake)));
}

async function emit(eventType: string, payload: Record<string, unknown>): Promise<string> {
  const db = getDb();
  const { id } = await db.transaction((tx) =>
    emitDomainEvent(tx, { eventType: eventType as never, aggregateType: 'stock', payload, companyId: COMPANY }),
  );
  return id;
}

beforeAll(async () => {
  await getDb()
    .insert(pricingRules)
    .values({ companyId: COMPANY, category: null, preorderBands: [{ minDaysToEta: 0, discountBp: 500 }, { minDaysToEta: 60, discountBp: 2000 }], bankOnlyEtaDays: 30 })
    .onConflictDoNothing();
});

afterEach(async () => {
  const db = getDb();
  const users = await db.select({ id: storefrontUsers.id }).from(storefrontUsers).where(like(storefrontUsers.email, 'ntf-%@example.test'));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    const orders = await db.select({ id: preorderOrders.id }).from(preorderOrders).where(inArray(preorderOrders.userId, ids));
    const oids = orders.map((o) => o.id);
    if (oids.length) await db.delete(preorderOrderLines).where(inArray(preorderOrderLines.orderId, oids));
    await db.delete(preorderOrders).where(inArray(preorderOrders.userId, ids));
    await db.delete(messageDrafts).where(inArray(messageDrafts.userId, ids));
    await db.delete(interestFlags).where(inArray(interestFlags.userId, ids));
    await db.delete(storefrontUsers).where(inArray(storefrontUsers.id, ids));
  }
  await db.delete(domainEvents).where(eq(domainEvents.aggregateType, 'stock'));
  const prods = await db.select({ id: products.id }).from(products).where(and(eq(products.companyId, COMPANY), like(products.stockCode, 'NTF-%')));
  if (prods.length) await db.delete(stockItems).where(inArray(stockItems.productId, prods.map((p) => p.id)));
  await db.delete(inboundShipmentLines).where(like(inboundShipmentLines.sku, 'NTF-%'));
  await db.delete(inboundShipments).where(like(inboundShipments.reference, 'NTF-%'));
  await db.delete(products).where(and(eq(products.companyId, COMPANY), like(products.stockCode, 'NTF-%')));
  await db.delete(warehouses).where(and(eq(warehouses.companyId, COMPANY), eq(warehouses.name, 'NTF WH')));
});

afterAll(async () => {
  await closeDatabase();
});

describe('back-in-stock fanout', () => {
  it('composes for every active restock watcher and clears the flags', async () => {
    const db = getDb();
    const sku = 'NTF-BIS';
    const users = await Promise.all(
      [0, 1, 2].map(async () => {
        const [u] = await db.insert(storefrontUsers).values({ companyId: COMPANY, email: email(), kind: 'guest' }).returning({ id: storefrontUsers.id });
        await db.insert(interestFlags).values({ companyId: COMPANY, userId: u!.id, sku, flagType: 'restock' });
        return u!.id;
      }),
    );
    const eventId = await emit('stock.replenished', { sku, qty: 5, pool: 'warehouse' });
    const n = await notifierWith(3).backInStockFanout(eventId);
    expect(n).toBe(3);

    const drafts = await db.select().from(messageDrafts).where(inArray(messageDrafts.userId, users));
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.groupKey === `back_in_stock:${sku}`)).toBe(true);
    const active = await db.select().from(interestFlags).where(inArray(interestFlags.userId, users));
    expect(active.every((f) => f.clearedAt !== null)).toBe(true);
  });
});

describe('ETA-slip reaction', () => {
  it('notifies affected pre-order customers once (idempotent), respecting the threshold', async () => {
    const db = getDb();
    const sku = 'NTF-ETA';
    const [u] = await db.insert(storefrontUsers).values({ companyId: COMPANY, email: email(), kind: 'account' }).returning({ id: storefrontUsers.id });
    await db.insert(products).values({ companyId: COMPANY, name: 'Eta', stockCode: sku, minSellingPrice: '20.00' });
    const eta = new Date(NOW + 70 * DAY);
    const [ship] = await db.insert(inboundShipments).values({ companyId: COMPANY, reference: 'NTF-SHIP', etaOriginal: eta, eta, status: 'in_transit', bufferPct: 0 }).returning({ id: inboundShipments.id });
    await db.insert(inboundShipmentLines).values({ companyId: COMPANY, shipmentId: ship!.id, sku, qtyManifested: 100 });
    await new PreorderService().createPreorder({ userId: u!.id, items: [{ sku, qty: 1, poolRef: 'NTF-SHIP' }], paymentMethod: 'manual_transfer', nowMs: NOW });

    // A 9-day slip.
    const worse = await emit('shipment.eta_changed', {
      shipmentId: ship!.id,
      oldEta: eta.toISOString(),
      newEta: new Date(eta.getTime() + 9 * DAY).toISOString(),
    });
    const notifier = notifierWith(2);
    expect(await notifier.reactEtaChanged(worse)).toBe(1);
    expect(await notifier.reactEtaChanged(worse)).toBe(0); // idempotent per (order, eta)

    // A 1-day slip is below the 2-day threshold → no notification.
    const minor = await emit('shipment.eta_changed', {
      shipmentId: ship!.id,
      oldEta: eta.toISOString(),
      newEta: new Date(eta.getTime() + 1 * DAY).toISOString(),
    });
    expect(await notifier.reactEtaChanged(minor)).toBe(0);
  });
});

describe('arrival closes the pre-order window', () => {
  it('quoting an arrived pool returns POOL_UNAVAILABLE', async () => {
    const db = getDb();
    const sku = 'NTF-ARR';
    const [wh] = await db.insert(warehouses).values({ companyId: COMPANY, name: 'NTF WH', isDefault: false }).returning({ id: warehouses.id });
    await db.insert(products).values({ companyId: COMPANY, name: 'Arr', stockCode: sku, minSellingPrice: '20.00', defaultWarehouseId: wh!.id });
    const eta = new Date(NOW + 10 * DAY);
    const inbound = new InboundService();
    const shipment = await inbound.createShipment({ reference: 'NTF-ARRSHIP', eta, bufferPct: 0, lines: [{ sku, qtyManifested: 50 }] });
    await inbound.goodsIn(shipment.id, [{ sku, qtyReceived: 50 }]); // arrived

    await expect(new PricingService().quote({ sku, qty: 1, pool: 'NTF-ARRSHIP', nowMs: NOW })).rejects.toMatchObject({ code: 'POOL_UNAVAILABLE' });
  });
});

describe('cancel drafts on consent revocation', () => {
  it('cancels a user’s pending marketing drafts', async () => {
    const db = getDb();
    const [u] = await db.insert(storefrontUsers).values({ companyId: COMPANY, email: email(), kind: 'account' }).returning({ id: storefrontUsers.id });
    await db.insert(messageDrafts).values({ companyId: COMPANY, userId: u!.id, category: 'marketing', subject: 's', body: 'b', status: 'pending' });
    const n = await new NotificationService().cancelDraftsForUser(u!.id);
    expect(n).toBe(1);
    const [d] = await db.select().from(messageDrafts).where(eq(messageDrafts.userId, u!.id));
    expect(d!.status).toBe('failed');
  });
});

describe('swap-at-locked-price', () => {
  it('conserves stock and money: presale released, warehouse consumed, price locked', async () => {
    const db = getDb();
    const sku = 'NTF-SWAP';
    const [wh] = await db.insert(warehouses).values({ companyId: COMPANY, name: 'NTF WH', isDefault: false }).returning({ id: warehouses.id });
    const [p] = await db.insert(products).values({ companyId: COMPANY, name: 'Swap', stockCode: sku, minSellingPrice: '20.00', defaultWarehouseId: wh!.id }).returning({ id: products.id });
    await db.insert(stockItems).values(Array.from({ length: 5 }, () => ({ companyId: COMPANY, productId: p!.id, warehouseId: wh!.id, quantity: 1, status: 'IN_STOCK' as const })));
    const eta = new Date(NOW + 70 * DAY);
    const [ship] = await db.insert(inboundShipments).values({ companyId: COMPANY, reference: 'NTF-SWAPSHIP', etaOriginal: eta, eta, status: 'in_transit', bufferPct: 0 }).returning({ id: inboundShipments.id });
    await db.insert(inboundShipmentLines).values({ companyId: COMPANY, shipmentId: ship!.id, sku, qtyManifested: 100 });
    const order = await new PreorderService().createPreorder({ userId: (await db.insert(storefrontUsers).values({ companyId: COMPANY, email: email(), kind: 'account' }).returning({ id: storefrontUsers.id }))[0]!.id, items: [{ sku, qty: 2, poolRef: 'NTF-SWAPSHIP' }], paymentMethod: 'manual_transfer', nowMs: NOW });
    const [line] = await db.select().from(preorderOrderLines).where(eq(preorderOrderLines.orderId, order.id));
    const lockedBefore = line!.lockedUnitPricePence;

    await new NotificationService().swapToWarehouse(order.id, line!.id);

    const [after] = await db.select().from(preorderOrderLines).where(eq(preorderOrderLines.id, line!.id));
    expect(after!.poolRef).toBe('warehouse');
    expect(after!.lockedUnitPricePence).toBe(lockedBefore); // money conserved

    const [shipLine] = await db.select().from(inboundShipmentLines).where(eq(inboundShipmentLines.shipmentId, ship!.id));
    expect(shipLine!.qtyPresold).toBe(0); // presale released

    const inStock = await db.select().from(stockItems).where(and(eq(stockItems.productId, p!.id), eq(stockItems.status, 'IN_STOCK')));
    expect(inStock).toHaveLength(3); // 5 − 2 consumed
  });
});
