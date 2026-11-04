/**
 * Back in stock through the gate (runbook section 3). Real Postgres; the
 * NotifyMeService decides who is due, GateNotifyMeSender turns them into
 * email_sends rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import { emailSends, stockItems, stockNotifications, warehouses } from '../../../db/schema/index.js';
import { NotifyMeService } from '../../storefront/notify-me.service.js';
import { BackInStockService, GateNotifyMeSender } from './back-in-stock.service.js';
import { ContactsService } from './contacts.service.js';
import { cleanupFixtures, makeContact, makeGroup, makeProduct, uniqueEmail } from '../testing.js';

const COMPANY = getSingletonCompanyId();
const notifyMe = new NotifyMeService();
const contacts = new ContactsService();
let warehouseId: string;
const productIds: string[] = [];

beforeAll(async () => {
  const [w] = await getDb().insert(warehouses).values({ companyId: COMPANY, name: 'BIS email WH' }).returning();
  warehouseId = w!.id;
});

afterAll(async () => {
  const db = getDb();
  if (productIds.length) {
    await db.delete(stockItems).where(inArray(stockItems.productId, productIds));
    await db.delete(stockNotifications).where(inArray(stockNotifications.productId, productIds));
  }
  await db.delete(warehouses).where(eq(warehouses.id, warehouseId));
  await cleanupFixtures();
});

async function product(name = 'Landu PETG Pro Galaxy Black') {
  const g = await makeGroup('Landu PETG Pro 1.75mm 1kg');
  const p = await makeProduct(name, { groupId: g.id, colour: 'Black' });
  productIds.push(p.id);
  return p;
}

async function stockIn(productId: string, n = 1) {
  await getDb()
    .insert(stockItems)
    .values(Array.from({ length: n }, () => ({ companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK' as const, quantity: 1 })));
}

async function soldOut(productId: string) {
  await getDb().update(stockItems).set({ status: 'SOLD' }).where(eq(stockItems.productId, productId));
}

async function sendsFor(contactId: string) {
  return getDb().select().from(emailSends).where(and(eq(emailSends.contactId, contactId), eq(emailSends.kind, 'back_in_stock'))).orderBy(emailSends.createdAt);
}

describe('recording a request', () => {
  it('creates the contact (no marketing consent) with interest in the product, and links it', async () => {
    const p = await product();
    const email = uniqueEmail('bisrec');
    await notifyMe.record(COMPANY, { productId: p.id, email, subscribeToNewsletter: false });
    const c = await contacts.getByEmail(email);
    expect(c).toBeDefined();
    expect(c!.marketingStatus).toBe('transactional_only');
    expect(c!.consentSource).toBe('back_in_stock_form');
    expect(c!.interests['material:petg']!.score).toBe(10);
    const [req] = await getDb().select().from(stockNotifications).where(eq(stockNotifications.email, email));
    expect(req!.contactId).toBe(c!.id);
  });
});

describe('stock coming back', () => {
  it('queues a requested-service send for a single open request, and closes the request', async () => {
    const p = await product();
    const email = uniqueEmail('bis1');
    await notifyMe.record(COMPANY, { productId: p.id, email, subscribeToNewsletter: false });
    await stockIn(p.id);
    expect(await notifyMe.fulfilForProduct(COMPANY, p.id, new GateNotifyMeSender())).toBe(1);

    const c = (await contacts.getByEmail(email))!;
    const sends = await sendsFor(c.id);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ class: 'requested_service', status: 'queued', templateKey: 'back_in_stock' });
    expect(sends[0]!.notBefore.getTime()).toBeLessThanOrEqual(Date.now());
    expect((sends[0]!.data as { items: Array<{ productId: string }> }).items[0]!.productId).toBe(p.id);
    const [req] = await getDb().select().from(stockNotifications).where(eq(stockNotifications.email, email));
    expect(req!.fulfilledAt).not.toBeNull();
    expect(req!.emailSendId).toBe(sends[0]!.id);
    expect(sends[0]!.idempotencyKey).toBe(`bis:${req!.id}`);
  });

  it.each([
    ['never', 'all', 'dropped', 'never'],
    ['transactional_only', 'ok', 'queued', null],
    ['all', 'hard_bounce', 'dropped', 'hard_bounce'],
  ] as const)('a %s / %s contact is %s', async (status, deliverability, outcome, reason) => {
    const p = await product();
    const c = await makeContact({ initialStatus: status });
    if (deliverability === 'hard_bounce') await contacts.recordDeliverability(c.id, 'hard_bounce');
    await notifyMe.record(COMPANY, { productId: p.id, email: c.email, subscribeToNewsletter: false });
    await stockIn(p.id);
    await notifyMe.fulfilForProduct(COMPANY, p.id, new GateNotifyMeSender());
    const [s] = await sendsFor(c.id);
    expect(s!.status).toBe(outcome);
    expect(s!.dropReason).toBe(reason);
  });

  it('sends once for two stock crossings within 24 hours, and again once the 24 hours are up', async () => {
    const p = await product();
    const email = uniqueEmail('bis24');
    const t0 = new Date();
    await notifyMe.record(COMPANY, { productId: p.id, email, subscribeToNewsletter: false });
    await stockIn(p.id);
    await notifyMe.fulfilForProduct(COMPANY, p.id, new GateNotifyMeSender(() => t0));

    // Sold out, re-enrolled, back again 3 hours later.
    await soldOut(p.id);
    await notifyMe.record(COMPANY, { productId: p.id, email, subscribeToNewsletter: false });
    await stockIn(p.id);
    const later = new Date(t0.getTime() + 3 * 3_600_000);
    expect(await notifyMe.fulfilForProduct(COMPANY, p.id, new GateNotifyMeSender(() => later))).toBe(0);
    const c = (await contacts.getByEmail(email))!;
    expect(await sendsFor(c.id)).toHaveLength(1);

    // The daily re-check after 24 hours sends it.
    const nextDay = new Date(t0.getTime() + 25 * 3_600_000);
    await new BackInStockService(new GateNotifyMeSender(() => nextDay)).recheckOpenRequests();
    expect(await sendsFor(c.id)).toHaveLength(2);
  });

  it('rolls two of one contact\'s requests that come back within the hour into one send at 09:00 UK', async () => {
    const a = await product('Landu PETG Pro Red');
    const b = await product('Landu PLA Basic Blue');
    const email = uniqueEmail('bisroll');
    await notifyMe.record(COMPANY, { productId: a.id, email, subscribeToNewsletter: false });
    await notifyMe.record(COMPANY, { productId: b.id, email, subscribeToNewsletter: false });
    const t = new Date('2026-11-05T14:00:00Z');
    await stockIn(a.id);
    await notifyMe.fulfilForProduct(COMPANY, a.id, new GateNotifyMeSender(() => t));
    await stockIn(b.id);
    await notifyMe.fulfilForProduct(COMPANY, b.id, new GateNotifyMeSender(() => new Date(t.getTime() + 40 * 60_000)));

    const c = (await contacts.getByEmail(email))!;
    const sends = await sendsFor(c.id);
    expect(sends).toHaveLength(1);
    const items = (sends[0]!.data as { items: Array<{ productId: string }> }).items.map((i) => i.productId);
    expect(items).toEqual([a.id, b.id]);
    expect(sends[0]!.notBefore.toISOString()).toBe('2026-11-06T09:00:00.000Z');
    const reqs = await getDb().select().from(stockNotifications).where(eq(stockNotifications.email, email));
    expect(reqs.every((r) => r.emailSendId === sends[0]!.id)).toBe(true);
  });

  it('closes a request older than 180 days without sending', async () => {
    const p = await product();
    const email = uniqueEmail('bisold');
    await notifyMe.record(COMPANY, { productId: p.id, email, subscribeToNewsletter: false });
    const now = new Date();
    await getDb().update(stockNotifications).set({ requestedAt: new Date(now.getTime() - 181 * 86_400_000) }).where(eq(stockNotifications.email, email));
    expect(await new BackInStockService().closeStale(now)).toBeGreaterThanOrEqual(1);
    const [req] = await getDb().select().from(stockNotifications).where(eq(stockNotifications.email, email));
    expect(req!.closeReason).toBe('expired');
    expect(req!.deletedAt).not.toBeNull();
    await stockIn(p.id);
    await notifyMe.fulfilForProduct(COMPANY, p.id, new GateNotifyMeSender());
    const c = (await contacts.getByEmail(email))!;
    expect(await sendsFor(c.id)).toHaveLength(0);
  });
});
