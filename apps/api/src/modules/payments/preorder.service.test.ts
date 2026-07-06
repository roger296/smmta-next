/**
 * Pre-order payment flow tests (Prompt 6, SPEC §16). Real Postgres at
 * DATABASE_URL; in-memory Mollie fake (NODE_ENV=test).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  products,
  pricingRules,
  inboundShipments,
  inboundShipmentLines,
  preorderOrders,
  preorderOrderLines,
  storefrontUsers,
  domainEvents,
} from '../../db/schema/index.js';
import { PreorderService, PaymentMethodNotAllowedError } from './preorder.service.js';
import { getMollie } from '../../integrations/mollie/index.js';
import { FakeMollie } from '../../integrations/mollie/mollie.fake.js';

const COMPANY = getSingletonCompanyId();
const svc = new PreorderService();
const NOW = Date.parse('2026-07-04T00:00:00Z');
const DAY = 86_400_000;
const SKU = 'PAY-PLA';
const POOL70 = 'PAY-POOL-70';
const POOL20 = 'PAY-POOL-20';
let userId: string;
let ship70Id: string;

async function eventsFor(orderId: string, type: string) {
  return getDb()
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.aggregateId, orderId), eq(domainEvents.eventType, type)));
}

async function makePool(ref: string, etaDays: number): Promise<string> {
  const db = getDb();
  const eta = new Date(NOW + etaDays * DAY);
  const [ship] = await db
    .insert(inboundShipments)
    .values({ companyId: COMPANY, reference: ref, etaOriginal: eta, eta, status: 'in_transit', bufferPct: 0 })
    .returning({ id: inboundShipments.id });
  await db
    .insert(inboundShipmentLines)
    .values({ companyId: COMPANY, shipmentId: ship!.id, sku: SKU, qtyManifested: 100 });
  return ship!.id;
}

beforeAll(async () => {
  const db = getDb();
  await db
    .insert(pricingRules)
    .values({ companyId: COMPANY, category: null, preorderBands: [
      { minDaysToEta: 60, discountBp: 2000 },
      { minDaysToEta: 30, discountBp: 1500 },
      { minDaysToEta: 14, discountBp: 1000 },
      { minDaysToEta: 0, discountBp: 500 },
    ], bankOnlyEtaDays: 30 })
    .onConflictDoNothing();
  await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Pay PLA', stockCode: SKU, minSellingPrice: '20.00', landedCostPence: 500 })
    .onConflictDoNothing();
  const [u] = await db
    .insert(storefrontUsers)
    .values({ companyId: COMPANY, email: 'pay@example.test', kind: 'account' })
    .returning({ id: storefrontUsers.id });
  userId = u!.id;
  ship70Id = await makePool(POOL70, 70);
  await makePool(POOL20, 20);
});

afterEach(async () => {
  // Reset presale between tests by clearing preorder orders + restoring qtyPresold.
  const db = getDb();
  const orders = await db
    .select({ id: preorderOrders.id })
    .from(preorderOrders)
    .where(eq(preorderOrders.userId, userId));
  const ids = orders.map((o) => o.id);
  if (ids.length) {
    await db.delete(preorderOrderLines).where(inArray(preorderOrderLines.orderId, ids));
    await db.delete(domainEvents).where(inArray(domainEvents.aggregateId, ids));
    await db.delete(preorderOrders).where(inArray(preorderOrders.id, ids));
  }
  await db.update(inboundShipmentLines).set({ qtyPresold: 0 }).where(eq(inboundShipmentLines.sku, SKU));
});

afterAll(async () => {
  const db = getDb();
  await db.delete(inboundShipmentLines).where(eq(inboundShipmentLines.sku, SKU));
  await db.delete(inboundShipments).where(like(inboundShipments.reference, 'PAY-%'));
  await db.delete(products).where(and(eq(products.companyId, COMPANY), like(products.stockCode, 'PAY-%')));
  await db.delete(storefrontUsers).where(eq(storefrontUsers.id, userId));
  await closeDatabase();
});

describe('createPreorder — >30-day bank-only + band lock + presale', () => {
  it('locks the band/£ savings and allocates presale; >30-day order is bank-only', async () => {
    const order = await svc.createPreorder({
      userId,
      items: [{ sku: SKU, qty: 2, poolRef: POOL70 }],
      paymentMethod: 'manual_transfer',
      nowMs: NOW,
    });
    expect(order.status).toBe('awaiting_payment');
    expect(order.paymentReference).toMatch(/^PO-/);

    const db = getDb();
    const [line] = await db.select().from(preorderOrderLines).where(eq(preorderOrderLines.orderId, order.id));
    // base £20, 70-day band 20% → unit £16.00, save £4.00.
    expect(line!.lockedBandBp).toBe(2000);
    expect(line!.lockedUnitPricePence).toBe(1600);
    expect(line!.lockedSavingPence).toBe(400);

    // presale allocated on the pool.
    const [shipLine] = await db
      .select()
      .from(inboundShipmentLines)
      .where(and(eq(inboundShipmentLines.shipmentId, ship70Id), eq(inboundShipmentLines.sku, SKU)));
    expect(shipLine!.qtyPresold).toBe(2);
  });

  it('rejects a card method on a >30-day order', async () => {
    await expect(
      svc.createPreorder({ userId, items: [{ sku: SKU, qty: 1, poolRef: POOL70 }], paymentMethod: 'card', nowMs: NOW }),
    ).rejects.toBeInstanceOf(PaymentMethodNotAllowedError);
  });
});

describe('band lock survives a later pricing_rules change', () => {
  it('keeps the locked price even after the bands change', async () => {
    const db = getDb();
    const order = await svc.createPreorder({
      userId,
      items: [{ sku: SKU, qty: 1, poolRef: POOL70 }],
      paymentMethod: 'manual_transfer',
      nowMs: NOW,
    });
    const [before] = await db.select().from(preorderOrderLines).where(eq(preorderOrderLines.orderId, order.id));

    // Slash the bands to zero.
    await db
      .update(pricingRules)
      .set({ preorderBands: [{ minDaysToEta: 0, discountBp: 0 }] })
      .where(and(eq(pricingRules.companyId, COMPANY)));

    const [after] = await db.select().from(preorderOrderLines).where(eq(preorderOrderLines.orderId, order.id));
    expect(after!.lockedUnitPricePence).toBe(before!.lockedUnitPricePence);
    expect(after!.lockedBandBp).toBe(2000);

    // Restore bands for other tests.
    await db
      .update(pricingRules)
      .set({ preorderBands: [
        { minDaysToEta: 60, discountBp: 2000 },
        { minDaysToEta: 30, discountBp: 1500 },
        { minDaysToEta: 14, discountBp: 1000 },
        { minDaysToEta: 0, discountBp: 500 },
      ] })
      .where(eq(pricingRules.companyId, COMPANY));
  });
});

describe('payment-window-scan (frozen clock)', () => {
  it('emits overdue once at day 3 and lapses at day 5, releasing presale', async () => {
    const db = getDb();
    const order = await svc.createPreorder({
      userId,
      items: [{ sku: SKU, qty: 3, poolRef: POOL70 }],
      paymentMethod: 'manual_transfer',
      nowMs: NOW,
    });

    // Backdate to 4 days old → overdue but not lapsed.
    await db.update(preorderOrders).set({ createdAt: new Date(NOW - 4 * DAY) }).where(eq(preorderOrders.id, order.id));
    let res = await svc.scanPaymentWindow(NOW);
    expect(res.overdue).toBe(1);
    expect(res.lapsed).toBe(0);
    expect((await eventsFor(order.id, 'order.payment_overdue'))).toHaveLength(1);

    // A second scan does not re-notify.
    res = await svc.scanPaymentWindow(NOW);
    expect(res.overdue).toBe(0);
    expect((await eventsFor(order.id, 'order.payment_overdue'))).toHaveLength(1);

    // Age to 6 days → lapse, releasing exactly the 3 allocated presale units.
    await db.update(preorderOrders).set({ createdAt: new Date(NOW - 6 * DAY) }).where(eq(preorderOrders.id, order.id));
    res = await svc.scanPaymentWindow(NOW);
    expect(res.lapsed).toBe(1);
    const [o] = await db.select().from(preorderOrders).where(eq(preorderOrders.id, order.id));
    expect(o!.status).toBe('lapsed');
    const [shipLine] = await db
      .select()
      .from(inboundShipmentLines)
      .where(and(eq(inboundShipmentLines.shipmentId, ship70Id), eq(inboundShipmentLines.sku, SKU)));
    expect(shipLine!.qtyPresold).toBe(0); // released
  });
});

describe('Mollie webhook idempotency', () => {
  it('a repeated webhook drives the order to paid exactly once', async () => {
    const order = await svc.createPreorder({
      userId,
      items: [{ sku: SKU, qty: 1, poolRef: POOL20 }], // ≤30-day → card allowed → Mollie payment
      paymentMethod: 'card',
      nowMs: NOW,
    });
    const paymentId = (order as { molliePaymentId?: string }).molliePaymentId!;
    expect(paymentId).toBeTruthy();

    // Simulate the bank/customer paying.
    (getMollie() as FakeMollie).setStatus(paymentId, 'paid');

    await svc.handleWebhook(paymentId);
    await svc.handleWebhook(paymentId); // duplicate delivery

    const db = getDb();
    const [o] = await db.select().from(preorderOrders).where(eq(preorderOrders.id, order.id));
    expect(o!.status).toBe('paid');
    expect((await eventsFor(order.id, 'order.paid'))).toHaveLength(1);
  });
});
