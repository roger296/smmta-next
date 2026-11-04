/**
 * Automations (runbook section 12), each at its offsets with explicit clocks;
 * idempotency across repeated runs; orders ending sequences; service mail
 * reaching transactional-only contacts; win-back re-verifying first; and the
 * storefront consent / signup / basket endpoints.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';
import { getDb } from '../../../config/database.js';
import { customerOrders, customers, emailCarts, emailConsentEvents, emailContacts, emailSends } from '../../../db/schema/index.js';
import { runAutomations } from './automations.service.js';
import { AttributionService } from './attribution.service.js';
import { ContactsService } from './contacts.service.js';
import { renderTemplate } from '../templates/render.js';
import { cleanupFixtures, makeApiKey, makeContact, makeCustomer, makeGroup, makeOrder, makeProduct, uniqueEmail } from '../testing.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const contacts = new ContactsService();
let app: FastifyInstance;
let key: Awaited<ReturnType<typeof makeApiKey>>;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  key = await makeApiKey(['storefront:write']);
});
afterAll(async () => {
  await key.remove();
  await app.close();
  await cleanupFixtures();
});
afterEach(() => vi.unstubAllGlobals());

const sendsOf = (contactId: string, kind?: string) =>
  getDb().select().from(emailSends).where(kind ? and(eq(emailSends.contactId, contactId), eq(emailSends.kind, kind)) : eq(emailSends.contactId, contactId)).orderBy(emailSends.createdAt);

const run = (now: Date, only: string[]) => runAutomations(now, { only, ignoreSwitches: true });

async function customerWithContact(status: 'all' | 'transactional_only' = 'all') {
  const email = uniqueEmail('auto');
  const cust = await makeCustomer(email);
  const { contact } = await contacts.findOrCreateByEmail(email, { source: 'admin', customerId: cust.id, initialStatus: status });
  await getDb().update(customers).set({ contactId: contact.id }).where(eq(customers.id, cust.id));
  return { cust, contact };
}

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { authorization: `Bearer ${key.raw}` }, payload: payload as object });

describe('replenishment', () => {
  it('reminds at 85% of a spool\'s life, once, then follows up 10 days later; an order since ends it', async () => {
    const g = await makeGroup('Landu PLA Basic 1.75mm 1kg');
    const p = await makeProduct('PLA Black', { groupId: g.id });
    const { cust, contact } = await customerWithContact();
    await makeOrder(cust.id, [{ productId: p.id, quantity: 1 }], '2031-02-01');
    const ordered = Date.parse('2031-02-01T09:00:00Z');
    expect((await run(new Date(ordered + 30 * DAY), ['replenishment']))[0]!.candidates).toBeGreaterThanOrEqual(0);
    expect(await sendsOf(contact.id, 'replenishment')).toHaveLength(0);
    const at = new Date(ordered + 36 * DAY); // 0.85 × 42 = 35.7 days
    await run(at, ['replenishment']);
    await run(at, ['replenishment']); // idempotent
    let s = await sendsOf(contact.id, 'replenishment');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ templateKey: 'replenishment_1', status: 'queued' });
    expect(((s[0]!.data as any).blocks[0].props.products[0].productId)).toBe(p.id);
    // Sent; ten days on comes the follow-up.
    await getDb().update(emailSends).set({ status: 'sent', sentAt: at }).where(eq(emailSends.id, s[0]!.id));
    await run(new Date(at.getTime() + 10 * DAY + HOUR), ['replenishment']);
    s = await sendsOf(contact.id, 'replenishment');
    expect(s.map((x) => x.templateKey)).toEqual(['replenishment_1', 'replenishment_2']);

    // Another customer reorders before the follow-up: no follow-up.
    const other = await customerWithContact();
    await makeOrder(other.cust.id, [{ productId: p.id, quantity: 1 }], '2031-02-01');
    await run(at, ['replenishment']);
    const [first] = await sendsOf(other.contact.id, 'replenishment');
    await getDb().update(emailSends).set({ status: 'sent', sentAt: at }).where(eq(emailSends.id, first!.id));
    await makeOrder(other.cust.id, [{ productId: p.id, quantity: 1 }], '2031-03-10');
    await run(new Date(at.getTime() + 10 * DAY + HOUR), ['replenishment']);
    expect((await sendsOf(other.contact.id, 'replenishment')).map((x) => x.templateKey)).toEqual(['replenishment_1']);
  });

  it('uses the contact\'s own reorder interval once there are two orders', async () => {
    const p = await makeProduct('Landu PETG Pro Blue');
    const { cust, contact } = await customerWithContact();
    await makeOrder(cust.id, [{ productId: p.id, quantity: 1 }], '2031-01-01');
    await makeOrder(cust.id, [{ productId: p.id, quantity: 1 }], '2031-01-21'); // every 20 days
    const lastOrder = Date.parse('2031-01-21T09:00:00Z');
    await run(new Date(lastOrder + 18 * DAY), ['replenishment']); // 0.85 × 20 = 17 days
    expect(await sendsOf(contact.id, 'replenishment')).toHaveLength(1);
  });

  it('is marketing: a transactional-only contact is not sent one', async () => {
    const p = await makeProduct('Landu ABS White');
    const { cust, contact } = await customerWithContact('transactional_only');
    await makeOrder(cust.id, [{ productId: p.id, quantity: 1 }], '2031-02-01');
    await run(new Date(Date.parse('2031-02-01T09:00:00Z') + 48 * DAY), ['replenishment']); // 0.85 × 56
    const [s] = await sendsOf(contact.id, 'replenishment');
    expect(s).toMatchObject({ status: 'dropped', dropReason: 'transactional_only' });
  });
});

describe('abandoned basket', () => {
  it('1 h and 24 h reminders (no 72 h without a discount); an order stops it', async () => {
    const p = await makeProduct('Landu TPU Red');
    const email = uniqueEmail('cart');
    expect((await post('/storefront/email/cart', { cartId: `c-${email}`, channel: 'filament-store', email, lines: [{ productId: p.id, quantity: 2, priceGbp: '21.99' }] })).statusCode).toBe(200);
    const contact = (await contacts.getByEmail(email))!;
    await contacts.setMarketingStatus(contact.id, 'all', { source: 'checkout', actor: 'person' });
    const [cart] = await getDb().select().from(emailCarts).where(eq(emailCarts.externalCartId, `c-${email}`));
    const t0 = cart!.updatedAt;
    await run(new Date(t0.getTime() + 30 * 60_000), ['abandoned_cart']);
    expect(await sendsOf(contact.id, 'abandoned_cart')).toHaveLength(0);
    await run(new Date(t0.getTime() + HOUR + 60_000), ['abandoned_cart']);
    await run(new Date(t0.getTime() + 24 * HOUR + 60_000), ['abandoned_cart']);
    await run(new Date(t0.getTime() + 72 * HOUR + 60_000), ['abandoned_cart']);
    const s = await sendsOf(contact.id, 'abandoned_cart');
    expect(s.map((x) => x.templateKey)).toEqual(['abandoned_cart_1', 'abandoned_cart_2']);
    expect((s[0]!.data as any).blocks[0].props.lines[0]).toMatchObject({ productId: p.id, quantity: 2, priceGbp: '21.99' });

    // A second basket, then an order: nothing more.
    const email2 = uniqueEmail('cart2');
    const cust = await makeCustomer(email2);
    await post('/storefront/email/cart', { cartId: `c-${email2}`, channel: 'filament-store', email: email2, lines: [{ productId: p.id, quantity: 1 }] });
    const c2 = (await contacts.getByEmail(email2))!;
    await contacts.setMarketingStatus(c2.id, 'all', { source: 'checkout', actor: 'person' });
    await getDb().update(customers).set({ contactId: c2.id }).where(eq(customers.id, cust.id));
    const order = await makeOrder(cust.id, [{ productId: p.id, quantity: 1 }]);
    await new AttributionService().processOrder(order.id);
    const [cart2] = await getDb().select().from(emailCarts).where(eq(emailCarts.externalCartId, `c-${email2}`));
    expect(cart2!.orderedAt).not.toBeNull();
    await run(new Date(cart2!.updatedAt.getTime() + HOUR + 60_000), ['abandoned_cart']);
    expect(await sendsOf(c2.id, 'abandoned_cart')).toHaveLength(0);
  });
});

describe('welcome series', () => {
  it('a newsletter signup gets day 0 and day 3; an order skips the rest', async () => {
    const email = uniqueEmail('welcome');
    const res = await post('/storefront/email/subscribe', { email, interests: ['material:petg'], wording: 'Sign me up', ip: '203.0.113.5' });
    expect(res.statusCode).toBe(200);
    const contact = (await contacts.getByEmail(email))!;
    expect(contact).toMatchObject({ marketingStatus: 'all', consentSource: 'signup_form' });
    expect(Object.keys(contact.interests)).toEqual(['material:petg']);
    const t0 = contact.consentAt!;
    await run(new Date(t0.getTime() + 60_000), ['welcome']);
    await run(new Date(t0.getTime() + 3 * DAY + 60_000), ['welcome']);
    expect((await sendsOf(contact.id, 'welcome')).map((s) => s.templateKey)).toEqual(['welcome_1', 'welcome_2']);
    await getDb().update(emailContacts).set({ lastOrderAt: new Date(t0.getTime() + 5 * DAY) }).where(eq(emailContacts.id, contact.id));
    await run(new Date(t0.getTime() + 10 * DAY + 60_000), ['welcome']);
    expect(await sendsOf(contact.id, 'welcome')).toHaveLength(2);
  });
});

describe('post-purchase', () => {
  it('tips 7 days after delivery and a review at 14 — service mail, so transactional-only contacts get it', async () => {
    const p = await makeProduct('Landu PETG Pro Clear');
    const { cust, contact } = await customerWithContact('transactional_only');
    const order = await makeOrder(cust.id, [{ productId: p.id, quantity: 1 }], '2031-04-01');
    await getDb().update(customerOrders).set({ shippedDate: '2031-04-02' }).where(eq(customerOrders.id, order.id));
    const delivered = Date.parse('2031-04-04T12:00:00Z'); // shipped + 2 days
    await run(new Date(delivered + 7 * DAY + HOUR), ['post_purchase']);
    await run(new Date(delivered + 14 * DAY + HOUR), ['post_purchase']);
    const s = await sendsOf(contact.id, 'post_purchase');
    expect(s.map((x) => [x.templateKey, x.class, x.status])).toEqual([
      ['post_purchase_tips', 'service', 'queued'],
      ['review_request', 'service', 'queued'],
    ]);
    expect((s[0]!.data as any).blocks[0].props.markdown).toMatch(/PETG/);
  });

  it('service templates refuse offer blocks', async () => {
    await expect(
      renderTemplate({ templateKey: 'post_purchase_tips', kind: 'post_purchase', data: { blocks: [{ type: 'DealsList', props: { deals: [{ title: '3 for 2' }] } }] }, contact: { id: 'c', unsubscribeToken: 't', isTrade: false }, sendId: 's' }),
    ).rejects.toThrow(/offer/);
  });
});

describe('win-back', () => {
  it('re-verifies first and skips addresses Bouncer says are dead', async () => {
    const now = new Date('2031-09-01T10:00:00Z');
    const alive = await makeContact({ initialStatus: 'all' });
    const dead = await makeContact({ initialStatus: 'all' });
    const lastOrder = new Date(now.getTime() - 121 * DAY);
    await getDb().update(emailContacts).set({ lastOrderAt: lastOrder, createdAt: new Date(now.getTime() - 400 * DAY) }).where(like(emailContacts.email, alive.email));
    await getDb().update(emailContacts).set({ lastOrderAt: lastOrder, createdAt: new Date(now.getTime() - 400 * DAY) }).where(like(emailContacts.email, dead.email));
    const { resetEnvForTests } = await import('../../../config/env.js');
    process.env.BOUNCER_API_KEY = 'k';
    resetEnvForTests();
    let batchRequested = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/email/verify/batch')) {
        batchRequested = true;
        return new Response(JSON.stringify({ batchId: 'wb' }));
      }
      if (url.endsWith('/batch/wb')) return new Response(JSON.stringify({ status: 'completed' }));
      void init;
      return new Response(JSON.stringify([{ email: alive.email, status: 'deliverable' }, { email: dead.email, status: 'undeliverable' }]));
    }));
    try {
      await run(now, ['winback']);
    } finally {
      delete process.env.BOUNCER_API_KEY;
      resetEnvForTests();
    }
    expect(batchRequested).toBe(true);
    expect((await sendsOf(alive.id, 'winback')).map((s) => s.templateKey)).toEqual(['winback_1']);
    expect(await sendsOf(dead.id, 'winback')).toHaveLength(0);
    expect((await contacts.get(dead.id))!.deliverability).toBe('invalid');
  });
});

describe('storefront consent', () => {
  it('checkout box ticked → all with the form as evidence; unticked → transactional only', async () => {
    const yes = uniqueEmail('co-yes');
    const no = uniqueEmail('co-no');
    expect((await post('/storefront/email/consent', { email: yes, granted: true, form: 'checkout', wording: 'Email me about new filament and offers.', ip: '203.0.113.1', userAgent: 'UA' })).statusCode).toBe(200);
    await post('/storefront/email/consent', { email: no, granted: false, form: 'checkout' });
    const y = (await contacts.getByEmail(yes))!;
    expect(y).toMatchObject({ marketingStatus: 'all', consentSource: 'checkout' });
    expect(y.consentEvidence).toMatchObject({ form: 'checkout', ip: '203.0.113.1', wording: 'Email me about new filament and offers.' });
    expect((await contacts.getByEmail(no))!.marketingStatus).toBe('transactional_only');
    // Unticking later is a downgrade; a never contact is left alone.
    await post('/storefront/email/consent', { email: yes, granted: false, form: 'checkout' });
    expect((await contacts.getByEmail(yes))!.marketingStatus).toBe('transactional_only');
    const nev = await makeContact({ initialStatus: 'never' });
    await post('/storefront/email/consent', { email: nev.email, granted: true, form: 'checkout' });
    expect((await contacts.get(nev.id))!.marketingStatus).toBe('never');
    const ev = await getDb().select().from(emailConsentEvents).where(eq(emailConsentEvents.contactId, y.id));
    expect(ev.map((e) => e.source)).toEqual(['checkout', 'checkout']);
  });

  it('needs the storefront write key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/storefront/email/subscribe', payload: { email: 'x@example.com' } });
    expect(res.statusCode).toBe(401);
  });
});
