/**
 * Interest-flag + threshold-check tests (Prompt 7, SPEC F8, §13.3).
 * Real Postgres at DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  interestFlags,
  consentRecords,
  prospectiveProducts,
  domainEvents,
  products,
  inboundShipments,
  inboundShipmentLines,
  pricingRules,
} from '../../db/schema/index.js';
import { InterestFlagService, resolveFlagType } from './interest.service.js';

const COMPANY = getSingletonCompanyId();
const service = new InterestFlagService();
let seq = 0;
const email = () => `intf-${Date.now()}-${++seq}@example.test`;

async function eventsFor(aggregateId: string, type: string) {
  return getDb()
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.aggregateId, aggregateId), eq(domainEvents.eventType, type)));
}

beforeAll(async () => {
  await getDb()
    .insert(pricingRules)
    .values({ companyId: COMPANY, category: null, preorderBands: [{ minDaysToEta: 0, discountBp: 500 }, { minDaysToEta: 60, discountBp: 2000 }] })
    .onConflictDoNothing();
});

async function cleanup(): Promise<void> {
  const db = getDb();
  db;
  await db.execute(sql`ALTER TABLE consent_records DISABLE TRIGGER consent_records_no_delete`);
  try {
    const users = await db
      .select({ id: storefrontUsers.id })
      .from(storefrontUsers)
      .where(like(storefrontUsers.email, 'intf-%@example.test'));
    const ids = users.map((u) => u.id);
    if (ids.length) {
      await db.delete(interestFlags).where(inArray(interestFlags.userId, ids));
      await db.delete(consentRecords).where(inArray(consentRecords.userId, ids));
      await db.delete(domainEvents).where(inArray(domainEvents.aggregateId, ids));
      await db.delete(storefrontUsers).where(inArray(storefrontUsers.id, ids));
    }
    const pros = await db
      .select({ id: prospectiveProducts.id })
      .from(prospectiveProducts)
      .where(like(prospectiveProducts.name, 'INTF-%'));
    const pids = pros.map((p) => p.id);
    if (pids.length) {
      await db.delete(interestFlags).where(inArray(interestFlags.prospectiveId, pids));
      await db.delete(domainEvents).where(inArray(domainEvents.aggregateId, pids));
      await db.delete(prospectiveProducts).where(inArray(prospectiveProducts.id, pids));
    }
    await db.delete(inboundShipmentLines).where(like(inboundShipmentLines.sku, 'INTF-%'));
    await db.delete(inboundShipments).where(like(inboundShipments.reference, 'INTF-%'));
    await db.delete(products).where(and(eq(products.companyId, COMPANY), like(products.stockCode, 'INTF-%')));
  } finally {
    await db.execute(sql`ALTER TABLE consent_records ENABLE TRIGGER consent_records_no_delete`);
  }
}

afterEach(cleanup);
afterAll(async () => {
  await closeDatabase();
});

describe('resolveFlagType (F8 contextual button)', () => {
  it('maps product state to flag meaning', () => {
    expect(resolveFlagType('out_of_stock')).toBe('restock');
    expect(resolveFlagType('in_stock')).toBe('offers');
    expect(resolveFlagType('low_stock')).toBe('offers');
    expect(resolveFlagType('prospective')).toBe('register_interest');
  });
});

describe('createInterestFlag — guest flow', () => {
  it('creates user + flag_updates consent + flag atomically, with events', async () => {
    const e = email();
    const { userId, flagId } = await service.createInterestFlag({
      email: e,
      sku: 'INTF-SKU-1',
      flagType: 'restock',
      sourcePage: '/shop/x',
    });
    expect(flagId).toBeTruthy();

    const db = getDb();
    const [u] = await db.select().from(storefrontUsers).where(eq(storefrontUsers.id, userId));
    expect(u!.kind).toBe('guest');
    const consents = await db
      .select()
      .from(consentRecords)
      .where(and(eq(consentRecords.userId, userId), eq(consentRecords.consentType, 'flag_updates')));
    expect(consents.some((c) => c.granted)).toBe(true);
    expect((await eventsFor(userId, 'user.created')).length).toBe(1);
  });

  it('a duplicate flag is a no-op (unique index)', async () => {
    const e = email();
    const first = await service.createInterestFlag({ email: e, sku: 'INTF-DUP', flagType: 'restock' });
    const second = await service.createInterestFlag({
      userId: first.userId,
      sku: 'INTF-DUP',
      flagType: 'restock',
    });
    expect(second.flagId).toBeNull(); // conflict → no new row

    const db = getDb();
    const flags = await db
      .select()
      .from(interestFlags)
      .where(and(eq(interestFlags.userId, first.userId), eq(interestFlags.sku, 'INTF-DUP')));
    expect(flags).toHaveLength(1);
  });
});

describe('thresholdCheck — exactly once under concurrent flags', () => {
  it('crosses the threshold exactly once even when checked concurrently', async () => {
    const db = getDb();
    const [prospective] = await db
      .insert(prospectiveProducts)
      .values({ companyId: COMPANY, name: 'INTF-GroupBuy', interestThreshold: 3 })
      .returning({ id: prospectiveProducts.id });
    const pid = prospective!.id;

    // 3 guests each register interest → 3 interest.flag_created events.
    const eventIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { userId } = await service.createInterestFlag({
        email: email(),
        prospectiveId: pid,
        flagType: 'register_interest',
      });
      const evs = await eventsFor(pid, 'interest.flag_created');
      void userId;
      eventIds.push(evs[evs.length - 1]!.id);
    }

    // Run threshold-check concurrently for every event.
    await Promise.all(eventIds.map((id) => service.thresholdCheck(id)));

    const crossed = await eventsFor(pid, 'interest.threshold_crossed');
    expect(crossed).toHaveLength(1);
    expect(crossed[0]!.payload).toMatchObject({ threshold: 3 });

    const [p] = await db.select().from(prospectiveProducts).where(eq(prospectiveProducts.id, pid));
    expect(p!.thresholdCrossedAt).not.toBeNull();
    expect(p!.status).toBe('group_buy_open');
  });
});

describe('listInterests enrichment', () => {
  it('adds ETA + per-unit pre-order saving for a watched SKU on an unarrived pool', async () => {
    const db = getDb();
    const sku = 'INTF-ENR';
    await db
      .insert(products)
      .values({ companyId: COMPANY, name: 'Enrich', stockCode: sku, minSellingPrice: '20.00', landedCostPence: 500 });
    const eta = new Date(Date.now() + 70 * 86_400_000);
    const [ship] = await db
      .insert(inboundShipments)
      .values({ companyId: COMPANY, reference: 'INTF-POOL', etaOriginal: eta, eta, status: 'in_transit', bufferPct: 0 })
      .returning({ id: inboundShipments.id });
    await db
      .insert(inboundShipmentLines)
      .values({ companyId: COMPANY, shipmentId: ship!.id, sku, qtyManifested: 100 });

    const { userId } = await service.createInterestFlag({ email: email(), sku, flagType: 'restock' });
    const interests = await service.listInterests(userId);
    const watch = interests.find((i) => i.sku === sku)!;
    expect(watch.inbound).not.toBeNull();
    // base £20.00, 60+ day band 20% → save £4.00 = 400p.
    expect(watch.inbound!.preorderSavingPencePerUnit).toBe(400);
  });
});
