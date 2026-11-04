/**
 * The SendGrid webhook through the real app (signed like SendGrid signs it),
 * and the nightly reconciliation, auto-pause and attribution.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';
import { getDb } from '../../../config/database.js';
import { resetEnvForTests } from '../../../config/env.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import {
  customerOrders,
  customers,
  emailAlerts,
  emailConsentEvents,
  emailEvents,
  emailSends,
} from '../../../db/schema/index.js';
import { ContactsService } from './contacts.service.js';
import { SendsService, type EmailSend } from './sends.service.js';
import { interestKeysFromUrl } from './events.service.js';
import { MaintenanceService, type SuppressionKind } from './maintenance.service.js';
import { AttributionService } from './attribution.service.js';
import { getEmailSettings, updateEmailSettings } from './settings.service.js';
import { cleanupFixtures, makeContact, makeCustomer, makeOrder, makeProduct, uniqueEmail } from '../testing.js';

const contacts = new ContactsService();
const sends = new SendsService();
let app: FastifyInstance;
let privateKey: KeyObject;
let savedKey: string | undefined;

beforeAll(async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  privateKey = pair.privateKey;
  savedKey = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  // The runbook's name for the key; the existing name is left unset here.
  process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const before = process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY;
  delete process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY;
  resetEnvForTests();
  app = await buildApp();
  await app.ready();
  if (before !== undefined) process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY = before;
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  else process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = savedKey;
  resetEnvForTests();
  await app.close();
  await cleanupFixtures();
});

let n = 0;
async function post(events: Array<Record<string, unknown>>, opts: { badSig?: boolean } = {}) {
  const raw = JSON.stringify(events);
  const timestamp = String(1_700_000_000 + ++n);
  const sig = createSign('sha256').update(timestamp + raw).sign(privateKey).toString('base64');
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/sendgrid',
    headers: {
      'content-type': 'application/json',
      'x-twilio-email-event-webhook-signature': opts.badSig ? 'bad' : sig,
      'x-twilio-email-event-webhook-timestamp': timestamp,
    },
    payload: raw,
  });
}

async function sentSend(status: 'all' | 'transactional_only' = 'all', cls: 'marketing' | 'requested_service' = 'marketing') {
  const c = await makeContact({ initialStatus: status });
  const { send } = await sends.enqueue({ contactId: c.id, class: cls, kind: 'manual', templateKey: 'manual', idempotencyKey: `ev:${c.id}` });
  await getDb().update(emailSends).set({ status: 'sent', sentAt: new Date() }).where(eq(emailSends.id, send.id));
  return { contact: c, send };
}

const ev = (send: EmailSend, event: string, extra: Record<string, unknown> = {}) => ({
  email: 'x@example.com',
  event,
  sg_event_id: `sg-${send.id}-${event}-${Math.random()}`,
  timestamp: Math.floor(Date.now() / 1000),
  send_id: send.id,
  contact_id: send.contactId,
  ...extra,
});

const reload = async (id: string) => (await getDb().select().from(emailSends).where(eq(emailSends.id, id)))[0]!;

describe('webhook', () => {
  it('refuses a bad signature and writes nothing', async () => {
    const { send } = await sentSend();
    const res = await post([ev(send, 'delivered')], { badSig: true });
    expect(res.statusCode).toBe(401);
    expect(await getDb().select().from(emailEvents).where(eq(emailEvents.sendId, send.id))).toHaveLength(0);
  });

  it('applies delivered, open and click, crediting interest from the link', async () => {
    const { contact, send } = await sentSend();
    await contacts.recordDeliverability(contact.id, 'soft_bounce');
    const res = await post([
      ev(send, 'processed'),
      ev(send, 'delivered'),
      ev(send, 'open'),
      ev(send, 'click', { url: 'https://shop.example.com/shop/x?utm_source=email&ik=material:petg' }),
    ]);
    expect(res.statusCode).toBe(200);
    const row = await reload(send.id);
    expect(row.status).toBe('clicked');
    expect(row.deliveredAt).not.toBeNull();
    expect(row.firstOpenAt).not.toBeNull();
    expect(row.firstClickAt).not.toBeNull();
    const c = (await contacts.get(contact.id))!;
    expect(c.softBounceCount).toBe(0);
    expect(c.deliverability).toBe('ok');
    expect(c.lastClickAt).not.toBeNull();
    expect(c.interests['material:petg']!.score).toBe(2);
  });

  it('a later event never moves a send back', async () => {
    const { send } = await sentSend();
    await post([ev(send, 'click'), ev(send, 'delivered'), ev(send, 'deferred')]);
    expect((await reload(send.id)).status).toBe('clicked');
  });

  it('a hard bounce marks the address; a blocked bounce counts as soft', async () => {
    const a = await sentSend();
    await post([ev(a.send, 'bounce', { type: 'bounce', reason: '550 no such user' })]);
    expect((await reload(a.send.id)).status).toBe('bounced');
    expect((await contacts.get(a.contact.id))!.deliverability).toBe('hard_bounce');
    const b = await sentSend();
    await post([ev(b.send, 'bounce', { type: 'blocked', reason: 'mailbox full' })]);
    expect((await contacts.get(b.contact.id))!).toMatchObject({ deliverability: 'soft_bounce', softBounceCount: 1 });
  });

  it('three deferrals of one send count as a soft bounce', async () => {
    const { contact, send } = await sentSend();
    await post([ev(send, 'deferred'), ev(send, 'deferred')]);
    expect((await contacts.get(contact.id))!.softBounceCount).toBe(0);
    await post([ev(send, 'deferred')]);
    expect((await contacts.get(contact.id))!.softBounceCount).toBe(1);
  });

  it('dropped for an invalid address marks the contact invalid', async () => {
    const { contact, send } = await sentSend();
    await post([ev(send, 'dropped', { reason: 'Invalid' })]);
    expect((await reload(send.id)).status).toBe('dropped');
    expect((await contacts.get(contact.id))!.deliverability).toBe('invalid');
  });

  it('a spam report: complained, downgraded, with a consent event from the webhook', async () => {
    const { contact, send } = await sentSend('all');
    await post([ev(send, 'spamreport')]);
    expect((await reload(send.id)).status).toBe('complained');
    const c = (await contacts.get(contact.id))!;
    expect(c).toMatchObject({ deliverability: 'complained', marketingStatus: 'transactional_only' });
    const events = await getDb().select().from(emailConsentEvents).where(eq(emailConsentEvents.contactId, contact.id));
    expect(events.at(-1)).toMatchObject({ source: 'complaint_webhook', toStatus: 'transactional_only' });
  });

  it('an unsubscribe event is handled like a link unsubscribe', async () => {
    const { contact, send } = await sentSend('all');
    await post([ev(send, 'unsubscribe')]);
    expect((await reload(send.id)).status).toBe('unsubscribed');
    expect((await contacts.get(contact.id))!.marketingStatus).toBe('transactional_only');
  });

  it('ignores a duplicate sg_event_id', async () => {
    const { contact, send } = await sentSend();
    const e = ev(send, 'click', { url: 'https://shop.example.com/?ik=material:abs' });
    await post([e]);
    await post([e]);
    expect(await getDb().select().from(emailEvents).where(eq(emailEvents.sgEventId, e.sg_event_id))).toHaveLength(1);
    expect((await contacts.get(contact.id))!.interests['material:abs']!.score).toBe(2);
  });

  it('stores an event for an unknown send and still protects the address', async () => {
    const c = await makeContact();
    const res = await post([{ email: c.email, event: 'bounce', type: 'bounce', sg_event_id: `sg-unknown-${c.id}`, send_id: '00000000-0000-4000-8000-0000000000ff' }]);
    expect(res.statusCode).toBe(200);
    const [stored] = await getDb().select().from(emailEvents).where(eq(emailEvents.sgEventId, `sg-unknown-${c.id}`));
    expect(stored!.sendId).toBeNull();
    expect((await contacts.get(c.id))!.deliverability).toBe('hard_bounce');
  });

  it('reads interest keys from links', () => {
    expect(interestKeysFromUrl('https://x.test/p?ik=material:pla,material:petg&cid=not-a-uuid')).toEqual(['material:pla', 'material:petg']);
    expect(interestKeysFromUrl('https://x.test/p?ik=<script>')).toEqual([]);
    expect(interestKeysFromUrl(undefined)).toEqual([]);
  });
});

describe('reconcileSuppressions', () => {
  it('applies a suppression the webhook missed and leaves unknown addresses alone', async () => {
    const missed = await makeContact({ initialStatus: 'all' });
    const unsub = await makeContact({ initialStatus: 'all' });
    const lists: Partial<Record<SuppressionKind, string[]>> = {
      bounces: [missed.email.toUpperCase(), uniqueEmail('nobody')],
      unsubscribes: [unsub.email],
    };
    const r = await new MaintenanceService().reconcileSuppressions({ list: async (k) => lists[k] ?? [] });
    expect(r).toEqual({ checked: 3, applied: 2 });
    expect((await contacts.get(missed.id))!).toMatchObject({ deliverability: 'hard_bounce', marketingStatus: 'transactional_only' });
    expect((await contacts.get(unsub.id))!).toMatchObject({ deliverability: 'ok', marketingStatus: 'transactional_only' });
  });
});

describe('deliverabilityCheck', () => {
  // Rates are counted over sends in the window before `now`; a date far in the
  // future keeps other suites' sends out of the count.
  const NOW = new Date('2031-03-10T12:00:00Z');

  async function seed(count: number, complained: number) {
    const c = await makeContact({ initialStatus: 'all' });
    const rows = Array.from({ length: count }, (_, i) => ({
      companyId: getSingletonCompanyId(),
      contactId: c.id,
      class: 'marketing' as const,
      kind: 'manual',
      templateKey: 'manual',
      idempotencyKey: `dc:${c.id}:${i}`,
      status: (i < complained ? 'complained' : 'delivered') as 'complained' | 'delivered',
      sentAt: new Date(NOW.getTime() - 86_400_000),
    }));
    await getDb().insert(emailSends).values(rows);
    return c.id;
  }

  it('does nothing under 200 sends, and pauses marketing at 0.2% complaints over 200+', async () => {
    const before = await getEmailSettings();
    const svc = new MaintenanceService();
    await seed(150, 3);
    expect((await svc.deliverabilityCheck(NOW)).paused).toBe(false);
    await seed(850, 0); // 1000 sends, 3 complaints = 0.3%
    const r = await svc.deliverabilityCheck(NOW);
    expect(r.paused).toBe(true);
    const s = await getEmailSettings();
    expect(s.marketing_paused).toBe(true);
    expect(s.marketing_paused_reason).toMatch(/complaints 0\.30%/);
    const [alert] = await getDb().select().from(emailAlerts).where(eq(emailAlerts.kind, 'auto_pause')).orderBy(emailAlerts.createdAt).limit(1);
    expect(alert).toBeDefined();
    await updateEmailSettings({ marketing_paused: before.marketing_paused, marketing_paused_reason: before.marketing_paused_reason }, 'test');
    await getDb().delete(emailSends).where(eq(emailSends.sentAt, new Date(NOW.getTime() - 86_400_000)));
  });
});

describe('attribution', () => {
  it('credits an order placed 3 days after a click, not one 6 days after', async () => {
    const product = await makeProduct('Landu PETG Pro Orange');
    const svc = new AttributionService();
    for (const [days, expected] of [[3, true], [6, false]] as const) {
      const email = uniqueEmail(`attr${days}`);
      const customer = await makeCustomer(email);
      const { contact } = await contacts.findOrCreateByEmail(email, { source: 'admin', customerId: customer.id });
      await getDb().update(customers).set({ contactId: contact.id }).where(eq(customers.id, customer.id));
      const { send } = await sends.enqueue({ contactId: contact.id, class: 'marketing', kind: 'manual', templateKey: 'manual', idempotencyKey: `attr:${contact.id}` });
      const clickedAt = new Date(Date.now() - days * 86_400_000);
      await getDb().update(emailSends).set({ status: 'clicked', sentAt: clickedAt, firstClickAt: clickedAt }).where(eq(emailSends.id, send.id));
      const order = await makeOrder(customer.id, [{ productId: product.id, quantity: 1 }]);
      const out = await svc.processOrder(order.id);
      expect(out).toEqual({ status: 'processed', attributedSendId: expected ? send.id : null });
      const [o] = await getDb().select().from(customerOrders).where(eq(customerOrders.id, order.id));
      expect(o!.emailSendId).toBe(expected ? send.id : null);
      expect(await svc.processOrder(order.id)).toEqual({ status: 'already_processed' });
      const c = (await contacts.get(contact.id))!;
      expect(c.lastOrderAt).not.toBeNull();
      expect(c.interests['material:petg']!.score).toBe(10);
    }
  });

  it('creates a contact for a customer that has none, without marketing consent', async () => {
    const product = await makeProduct('Landu PLA Basic Grey');
    const email = uniqueEmail('attrnew');
    const customer = await makeCustomer(email);
    const order = await makeOrder(customer.id, [{ productId: product.id, quantity: 2 }]);
    await new AttributionService().processOrder(order.id);
    const c = (await contacts.getByEmail(email))!;
    expect(c).toMatchObject({ customerId: customer.id, marketingStatus: 'transactional_only', consentSource: 'order' });
    const [cust] = await getDb().select().from(customers).where(and(eq(customers.id, customer.id)));
    expect(cust!.contactId).toBe(c.id);
  });
});
