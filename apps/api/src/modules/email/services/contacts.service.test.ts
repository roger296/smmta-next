/**
 * Contacts and consent: every status transition, the consent event each one
 * writes, the database trigger, and deliverability signals. Real Postgres.
 */
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { emailConsentEvents, emailContacts, type MarketingStatus } from '../../../db/schema/index.js';
import { ConsentTransitionError, ContactsService, checkTransition } from './contacts.service.js';
import { makeContact, uniqueEmail } from '../testing.js';

const svc = new ContactsService();
const db = () => getDb();

async function events(contactId: string) {
  return db().select().from(emailConsentEvents).where(eq(emailConsentEvents.contactId, contactId)).orderBy(emailConsentEvents.createdAt);
}

describe('findOrCreateByEmail', () => {
  it('normalises, creates once, and records the initial status as a consent event', async () => {
    const email = uniqueEmail('foc');
    const a = await svc.findOrCreateByEmail(`  ${email.toUpperCase()} `, { source: 'checkout', initialStatus: 'all' });
    const b = await svc.findOrCreateByEmail(email, { source: 'signup_form' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.contact.id).toBe(a.contact.id);
    expect(a.contact.email).toBe(email);
    expect(a.contact.unsubscribeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ev = await events(a.contact.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ fromStatus: null, toStatus: 'all', source: 'checkout' });
  });

  it('links a later customer without touching consent', async () => {
    const c = await makeContact({ initialStatus: 'transactional_only' });
    const [cust] = await db().execute(sql`insert into customers (company_id, name, email) values (${c.companyId}, 'X', ${c.email}) returning id`).then((r) => (r as unknown as { rows: Array<{ id: string }> }).rows);
    const { contact } = await svc.findOrCreateByEmail(c.email, { source: 'checkout', customerId: cust!.id, initialStatus: 'all' });
    expect(contact.customerId).toBe(cust!.id);
    expect(contact.marketingStatus).toBe('transactional_only');
  });

  it('refuses garbage', async () => {
    await expect(svc.findOrCreateByEmail('not-an-address', { source: 'admin' })).rejects.toBeInstanceOf(ConsentTransitionError);
  });
});

// Every row of the spec's status-transition table, plus the forbidden moves.
describe('status transitions', () => {
  const cases: Array<{
    name: string;
    from: MarketingStatus;
    to: MarketingStatus;
    change: Parameters<ContactsService['setMarketingStatus']>[2];
    ok: boolean;
  }> = [
    { name: 'checkout form opts in', from: 'transactional_only', to: 'all', change: { source: 'checkout', actor: 'person' }, ok: true },
    { name: 'signup form opts in', from: 'transactional_only', to: 'all', change: { source: 'signup_form', actor: 'person' }, ok: true },
    { name: 'unsubscribe link', from: 'all', to: 'transactional_only', change: { source: 'link', actor: 'person' }, ok: true },
    { name: 'one-click header', from: 'all', to: 'transactional_only', change: { source: 'one_click', actor: 'person' }, ok: true },
    { name: 'preferences page unsubscribe', from: 'all', to: 'transactional_only', change: { source: 'preferences_page', actor: 'person' }, ok: true },
    { name: 'spam complaint', from: 'all', to: 'transactional_only', change: { source: 'complaint_webhook', actor: 'system' }, ok: true },
    { name: 'never, by admin with reason', from: 'all', to: 'never', change: { source: 'admin_ui', actor: 'u1', reason: 'phoned to ask', confirm: true }, ok: true },
    { name: 'never, by MCP with reason', from: 'transactional_only', to: 'never', change: { source: 'mcp', actor: 'claude', reason: 'emailed to ask', confirm: true }, ok: true },
    { name: 'never needs confirm', from: 'all', to: 'never', change: { source: 'admin_ui', actor: 'u1', reason: 'x' }, ok: false },
    { name: 'never needs a reason', from: 'all', to: 'never', change: { source: 'admin_ui', actor: 'u1', confirm: true }, ok: false },
    { name: 'never cannot come from a person', from: 'all', to: 'never', change: { source: 'preferences_page', actor: 'person' }, ok: false },
    { name: 're-subscribe on preferences page', from: 'transactional_only', to: 'all', change: { source: 'preferences_page', actor: 'person' }, ok: true },
    { name: 're-subscribe never from never', from: 'never', to: 'all', change: { source: 'preferences_page', actor: 'person' }, ok: false },
    { name: 'checkout never lifts never', from: 'never', to: 'all', change: { source: 'checkout', actor: 'person' }, ok: false },
    { name: 'admin override out of never', from: 'never', to: 'transactional_only', change: { source: 'admin_ui', actor: 'u1', reason: 'asked again', confirm: true }, ok: true },
    { name: 'admin upgrade needs confirm', from: 'transactional_only', to: 'all', change: { source: 'admin_ui', actor: 'u1', reason: 'r' }, ok: false },
    { name: 'admin upgrade with confirm', from: 'transactional_only', to: 'all', change: { source: 'admin_ui', actor: 'u1', reason: 'signed form', confirm: true }, ok: true },
    { name: 'import never upgrades', from: 'transactional_only', to: 'all', change: { source: 'csv_import', actor: 'system' }, ok: false },
    { name: 'import may downgrade', from: 'all', to: 'transactional_only', change: { source: 'csv_import', actor: 'system' }, ok: true },
    { name: 'import never touches never', from: 'never', to: 'transactional_only', change: { source: 'csv_import', actor: 'system' }, ok: false },
    { name: 'a webhook cannot upgrade', from: 'transactional_only', to: 'all', change: { source: 'complaint_webhook', actor: 'system' }, ok: false },
  ];

  it.each(cases)('$name', async ({ from, to, change, ok }) => {
    const c = await makeContact({ initialStatus: from });
    const before = (await events(c.id)).length;
    if (ok) {
      const res = await svc.setMarketingStatus(c.id, to, change);
      expect(res).toEqual({ changed: true, from, to });
      const after = await events(c.id);
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toMatchObject({ fromStatus: from, toStatus: to, source: change.source, actor: change.actor });
      expect((await svc.get(c.id))!.marketingStatus).toBe(to);
    } else {
      await expect(svc.setMarketingStatus(c.id, to, change)).rejects.toBeInstanceOf(ConsentTransitionError);
      expect(await events(c.id)).toHaveLength(before);
      expect((await svc.get(c.id))!.marketingStatus).toBe(from);
    }
  });

  it('writes nothing when the status does not change', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    const res = await svc.setMarketingStatus(c.id, 'all', { source: 'checkout', actor: 'person' });
    expect(res.changed).toBe(false);
    expect(await events(c.id)).toHaveLength(1);
  });

  it('checkTransition is the same rule without a database', () => {
    expect(() => checkTransition('all', 'never', { source: 'one_click', actor: 'p' })).toThrow(ConsentTransitionError);
    expect(() => checkTransition('all', 'transactional_only', { source: 'one_click', actor: 'p' })).not.toThrow();
  });
});

describe('the database guard', () => {
  it('refuses a direct UPDATE of marketing_status', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    await expect(
      db().update(emailContacts).set({ marketingStatus: 'transactional_only' }).where(eq(emailContacts.id, c.id)),
    ).rejects.toThrow();
    expect((await svc.get(c.id))!.marketingStatus).toBe('all');
  });

  it('refuses an UPDATE whose consent event was written in another transaction', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    await db().insert(emailConsentEvents).values({ companyId: c.companyId, contactId: c.id, fromStatus: 'all', toStatus: 'transactional_only', source: 'test', actor: 'test' });
    await expect(
      db().update(emailContacts).set({ marketingStatus: 'transactional_only' }).where(eq(emailContacts.id, c.id)),
    ).rejects.toThrow();
  });

  it('allows other column updates', async () => {
    const c = await makeContact();
    await db().update(emailContacts).set({ isTrade: true }).where(eq(emailContacts.id, c.id));
    expect((await svc.get(c.id))!.isTrade).toBe(true);
  });

  it('keeps consent events append-only', async () => {
    const c = await makeContact();
    await expect(db().update(emailConsentEvents).set({ reason: 'x' }).where(eq(emailConsentEvents.contactId, c.id))).rejects.toThrow();
    await expect(db().delete(emailConsentEvents).where(eq(emailConsentEvents.contactId, c.id))).rejects.toThrow();
  });

  it('refuses an address that is not normalised', async () => {
    await expect(
      db().insert(emailContacts).values({ companyId: '11111111-1111-4111-8111-111111111111', email: 'Upper@Example.com', consentSource: 'test' }),
    ).rejects.toThrow();
  });
});

describe('recordDeliverability', () => {
  it('counts soft bounces and clears them on delivery', async () => {
    const c = await makeContact();
    const now = new Date();
    expect(await svc.recordDeliverability(c.id, 'soft_bounce', now)).toBe('soft_bounce');
    await svc.recordDeliverability(c.id, 'soft_bounce', now);
    expect((await svc.get(c.id))!.softBounceCount).toBe(2);
    expect(await svc.recordDeliverability(c.id, 'delivered', now)).toBe('ok');
    expect((await svc.get(c.id))!.softBounceCount).toBe(0);
  });

  it('starts a new window after 30 days', async () => {
    const c = await makeContact();
    const t0 = new Date('2026-01-01T00:00:00Z');
    await svc.recordDeliverability(c.id, 'soft_bounce', t0);
    await svc.recordDeliverability(c.id, 'soft_bounce', new Date('2026-03-01T00:00:00Z'));
    expect((await svc.get(c.id))!.softBounceCount).toBe(1);
  });

  it('escalates a Bouncer-risky address on its first soft bounce', async () => {
    const c = await makeContact();
    await db().update(emailContacts).set({ bouncerResult: 'risky' }).where(eq(emailContacts.id, c.id));
    expect(await svc.recordDeliverability(c.id, 'soft_bounce')).toBe('hard_bounce');
  });

  it('never lets a delivery or soft bounce undo a hard bounce or complaint', async () => {
    const c = await makeContact();
    await svc.recordDeliverability(c.id, 'complained');
    expect(await svc.recordDeliverability(c.id, 'soft_bounce')).toBe('complained');
    expect(await svc.recordDeliverability(c.id, 'hard_bounce')).toBe('complained');
    expect(await svc.recordDeliverability(c.id, 'delivered')).toBe('complained');
  });
});

describe('interests', () => {
  it('adds points and decays them', async () => {
    const c = await makeContact();
    const t0 = new Date('2026-01-01T00:00:00Z');
    await svc.addInterest(c.id, ['material:pla'], 10, t0);
    await svc.addInterest(c.id, ['material:pla'], 2, new Date('2026-06-30T00:00:00Z'));
    const after = await svc.get(c.id);
    expect(after!.interests['material:pla']!.score).toBeCloseTo(7, 1);
  });
});
