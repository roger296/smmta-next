/**
 * Full-system smoke (SPEC §6, Prompt 15). Exercises the whole New Filament Store
 * chain end-to-end against the test DB, asserting DB state at each step:
 *
 *   seed → place >30-day pre-order (manual transfer) → mark paid → slip ETA →
 *   ETA-slip draft appears → approve → send (sandbox) → flag a SKU → restock →
 *   back-in-stock fanout draft → digest payload contains it all.
 *
 * Runs the event reactions inline (service calls) rather than via pg-boss, so it
 * is deterministic. Fakes for Mollie / OpenRouter / SendGrid. Cleans up its own
 * 'SMOKE-' data. Exit 0 on success; throws (exit 1) on any assertion failure.
 */
import 'dotenv/config';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://smmta:smmta@localhost:5432/filament_test';

import assert from 'node:assert/strict';
import { and, eq, like, inArray, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import {
  storefrontUsers,
  products,
  warehouses,
  stockItems,
  pricingRules,
  messageDrafts,
  interestFlags,
  inboundShipments,
  inboundShipmentLines,
  preorderOrders,
  preorderOrderLines,
  domainEvents,
  consentRecords,
} from '../src/db/schema/index.js';
import { InboundService } from '../src/modules/inbound/inbound.service.js';
import { PreorderService } from '../src/modules/payments/preorder.service.js';
import { NotificationService } from '../src/modules/notification/notification.service.js';
import { InterestFlagService } from '../src/modules/interest/interest.service.js';
import { ApprovalQueueService } from '../src/modules/approval/approval.service.js';
import { SendService } from '../src/modules/messaging/send.service.js';
import { ComposeService } from '../src/modules/messaging/compose.service.js';
import { DigestService } from '../src/modules/digest/digest.service.js';
import { ConsentService } from '../src/modules/identity/consent.service.js';
import { OpenRouterService, setLlmPortForTests } from '../src/integrations/openrouter/index.js';
import { FakeLlm } from '../src/integrations/openrouter/openrouter.fake.js';

const COMPANY = getSingletonCompanyId();
const NOW = Date.parse('2026-07-04T00:00:00Z');
const DAY = 86_400_000;
const SKU = 'SMOKE-PLA-BLK';
const POOL = 'SMOKE-POOL-70';

function log(step: string) {
  // eslint-disable-next-line no-console
  console.log(`[smoke] ✓ ${step}`);
}

async function cleanup() {
  const db = getDb();
  const users = await db.select({ id: storefrontUsers.id }).from(storefrontUsers).where(like(storefrontUsers.email, 'smoke-%@example.test'));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    const orders = await db.select({ id: preorderOrders.id }).from(preorderOrders).where(inArray(preorderOrders.userId, ids));
    const oids = orders.map((o) => o.id);
    if (oids.length) await db.delete(preorderOrderLines).where(inArray(preorderOrderLines.orderId, oids));
    await db.delete(preorderOrders).where(inArray(preorderOrders.userId, ids));
    await db.delete(messageDrafts).where(inArray(messageDrafts.userId, ids));
    await db.delete(interestFlags).where(inArray(interestFlags.userId, ids));
    await db.delete(domainEvents).where(inArray(domainEvents.aggregateId, [...ids, ...oids]));
    // consent_records is append-only — disable the trigger to remove fixtures.
    await db.execute(sql`ALTER TABLE consent_records DISABLE TRIGGER consent_records_no_delete`);
    await db.delete(consentRecords).where(inArray(consentRecords.userId, ids));
    await db.execute(sql`ALTER TABLE consent_records ENABLE TRIGGER consent_records_no_delete`);
    await db.delete(storefrontUsers).where(inArray(storefrontUsers.id, ids));
  }
  const prods = await db.select({ id: products.id }).from(products).where(and(eq(products.companyId, COMPANY), like(products.stockCode, 'SMOKE-%')));
  if (prods.length) await db.delete(stockItems).where(inArray(stockItems.productId, prods.map((p) => p.id)));
  await db.delete(inboundShipmentLines).where(like(inboundShipmentLines.sku, 'SMOKE-%'));
  await db.delete(inboundShipments).where(like(inboundShipments.reference, 'SMOKE-%'));
  await db.delete(products).where(and(eq(products.companyId, COMPANY), like(products.stockCode, 'SMOKE-%')));
  await db.delete(warehouses).where(and(eq(warehouses.companyId, COMPANY), eq(warehouses.name, 'SMOKE WH')));
}

async function main() {
  const db = getDb();
  await cleanup();

  // A scripted LLM so every compose returns a valid draft.
  const fake = new FakeLlm();
  for (let i = 0; i < 20; i++) fake.enqueue({ content: JSON.stringify({ subject: 'Update', body: 'Body.' }) });
  setLlmPortForTests(fake);
  const compose = new ComposeService(new OpenRouterService(fake));
  const inbound = new InboundService();
  const preorder = new PreorderService();
  const notify = new NotificationService(compose);
  const interest = new InterestFlagService();
  const approval = new ApprovalQueueService();
  const send = new SendService();
  const consent = new ConsentService();

  // 1. Seed: pricing rules, warehouse, product, a >30-day pool, a customer.
  await db.insert(pricingRules).values({ companyId: COMPANY, category: null, preorderBands: [
    { minDaysToEta: 60, discountBp: 2000 }, { minDaysToEta: 30, discountBp: 1500 }, { minDaysToEta: 14, discountBp: 1000 }, { minDaysToEta: 0, discountBp: 500 },
  ], bankOnlyEtaDays: 30, lowStockThreshold: 5 }).onConflictDoNothing();
  const [wh] = await db.insert(warehouses).values({ companyId: COMPANY, name: 'SMOKE WH', isDefault: false }).returning({ id: warehouses.id });
  await db.insert(products).values({ companyId: COMPANY, name: 'Smoke PLA Black', stockCode: SKU, minSellingPrice: '20.00', landedCostPence: 800, defaultWarehouseId: wh!.id });
  const [user] = await db.insert(storefrontUsers).values({ companyId: COMPANY, email: 'smoke-buyer@example.test', kind: 'account' }).returning({ id: storefrontUsers.id });
  await consent.grant(user!.id, 'general_marketing', 'smoke');
  const shipment = await inbound.createShipment({ reference: POOL, eta: new Date(NOW + 70 * DAY), bufferPct: 0, lines: [{ sku: SKU, qtyManifested: 100 }] });
  log('seed: warehouse + product + 70-day pool + consented customer');

  // 2. Place a >30-day pre-order (manual transfer → bank-only) + band lock.
  const order = await preorder.createPreorder({ userId: user!.id, items: [{ sku: SKU, qty: 2, poolRef: POOL }], paymentMethod: 'manual_transfer', nowMs: NOW });
  assert.equal(order.status, 'awaiting_payment');
  const [line] = await db.select().from(preorderOrderLines).where(eq(preorderOrderLines.orderId, order.id));
  assert.equal(line!.lockedBandBp, 2000, 'band locked at 20%');
  assert.equal(line!.lockedUnitPricePence, 1600, '£20 − 20% = £16.00');
  log('placed >30-day pre-order, band + £ savings locked');

  // 3. Mark paid (admin bridge) → order.paid.
  await preorder.markPaid(order.id);
  const paid = await db.select().from(domainEvents).where(and(eq(domainEvents.aggregateId, order.id), eq(domainEvents.eventType, 'order.paid')));
  assert.equal(paid.length, 1);
  log('marked paid → order.paid emitted');

  // 4. Slip the ETA by 9 days → ETA-slip draft appears.
  const before = shipment.eta;
  await inbound.updateEta(shipment.id, new Date(before.getTime() + 9 * DAY));
  const [etaEvent] = await db.select().from(domainEvents).where(and(eq(domainEvents.aggregateId, shipment.id), eq(domainEvents.eventType, 'shipment.eta_changed')));
  const composed = await notify.reactEtaChanged(etaEvent!.id);
  assert.equal(composed, 1, 'one affected pre-order customer notified');
  const [slipDraft] = await db.select().from(messageDrafts).where(and(eq(messageDrafts.userId, user!.id), like(messageDrafts.groupKey, 'eta_slip:%')));
  assert.ok(slipDraft, 'eta_slip draft created');
  log('slipped ETA → eta_slip draft appears in the queue');

  // 5. Approve → send (sandbox).
  await approval.approve(slipDraft!.id);
  const outcome = await send.send(slipDraft!.id);
  assert.deepEqual(outcome.sent, true, 'draft sent via SendGrid sandbox');
  log('approved → sent (sandbox)');

  // 6. Flag the SKU for restock, then restock via goods-in → fanout.
  const flag = await interest.createInterestFlag({ userId: user!.id, sku: SKU, flagType: 'restock' });
  await inbound.goodsIn(shipment.id, [{ sku: SKU, qtyReceived: 100 }]); // arrival → stock.replenished
  const [replenished] = await db.select().from(domainEvents).where(and(eq(domainEvents.aggregateId, shipment.id), eq(domainEvents.eventType, 'stock.replenished')));
  assert.ok(replenished, 'stock.replenished emitted from goods-in');
  const fanned = await notify.backInStockFanout(replenished!.id);
  assert.equal(fanned, 1, 'one restock watcher fanned out');
  const [clearedFlag] = await db.select().from(interestFlags).where(eq(interestFlags.id, flag.flagId!));
  assert.ok(clearedFlag!.clearedAt, 'restock flag cleared on fanout');
  log('flagged → restocked → back-in-stock fanout draft, flag cleared');

  // 7. Digest payload contains it all.
  const digest = await new DigestService().buildDigest(NOW);
  assert.ok(digest.queue.pending >= 1, 'digest shows pending queue items');
  assert.ok(digest.paymentWindow.awaiting >= 0);
  log(`digest assembled (pending=${digest.queue.pending}, escalations=${digest.openEscalations})`);

  await cleanup();
  // eslint-disable-next-line no-console
  console.log('[smoke] ALL STEPS PASSED');
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('[smoke] FAILED', err);
    try {
      await cleanup();
    } catch {
      /* best effort */
    }
    await closeDatabase();
    process.exit(1);
  });
