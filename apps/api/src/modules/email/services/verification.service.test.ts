/**
 * Verification (runbook section 5). Bouncer is stubbed; the test asserts the
 * stub saw every request, so no real call can slip through.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { domainEvents, emailContacts } from '../../../db/schema/index.js';
import { canSend } from '../lib/gate.js';
import { BouncerClient } from '../lib/bouncer.js';
import { defaultSettings } from '../lib/settings-defaults.js';
import { ContactsService } from './contacts.service.js';
import { VerificationService } from './verification.service.js';
import { makeContact, uniqueEmail } from '../testing.js';

const fx = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `test/fixtures/email/bouncer/${name}.json`), 'utf8'));
const contacts = new ContactsService();
const DAY = 86_400_000;

function stubBouncer(...statuses: string[]) {
  const seen: string[] = [];
  const queue = [...statuses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      seen.push(url);
      if (!url.startsWith('https://bouncer.test/')) throw new Error(`unexpected request ${url}`);
      return new Response(JSON.stringify(fx(queue.shift() ?? 'deliverable')));
    }),
  );
  return seen;
}
const service = () => new VerificationService(new BouncerClient({ apiKey: 'k', baseUrl: 'https://bouncer.test/v1.1' }));

afterEach(() => vi.unstubAllGlobals());

describe('verify on create', () => {
  it('a checkout contact emits email.contact_created in the same transaction; an import does not', async () => {
    const { contact: fromCheckout } = await contacts.findOrCreateByEmail(uniqueEmail('ver-co'), { source: 'checkout' });
    const { contact: fromImport } = await contacts.findOrCreateByEmail(uniqueEmail('ver-im'), { source: 'sendgrid_import' });
    const ev = (id: string) =>
      getDb().select().from(domainEvents).where(and(eq(domainEvents.eventType, 'email.contact_created'), eq(domainEvents.aggregateId, id)));
    expect(await ev(fromCheckout.id)).toHaveLength(1);
    expect(await ev(fromImport.id)).toHaveLength(0);
  });

  it('skips sources that are not verified, even if asked', async () => {
    const seen = stubBouncer();
    const c = await makeContact();
    expect(await service().verifyContact(c.id, { source: 'sendgrid_import' })).toEqual({ status: 'skipped', reason: 'source' });
    expect(seen).toHaveLength(0);
  });

  it('skips a contact checked in the last 90 days', async () => {
    const seen = stubBouncer();
    const c = await makeContact();
    await getDb().update(emailContacts).set({ bouncerResult: 'deliverable', bouncerCheckedAt: new Date(Date.now() - 30 * DAY) }).where(eq(emailContacts.id, c.id));
    expect(await service().verifyContact(c.id, { source: 'checkout' })).toEqual({ status: 'skipped', reason: 'fresh' });
    expect(seen).toHaveLength(0);
  });

  it('undeliverable sets invalid: the gate refuses marketing but allows order-required mail', async () => {
    const seen = stubBouncer('undeliverable');
    const c = await makeContact({ initialStatus: 'all' });
    expect(await service().verifyContact(c.id, { source: 'checkout' })).toEqual({ status: 'verified', result: 'undeliverable' });
    expect(seen).toHaveLength(1);
    const after = (await contacts.get(c.id))!;
    expect(after.deliverability).toBe('invalid');
    expect(after.bouncerResult).toBe('undeliverable');
    const now = new Date('2026-11-05T11:00:00Z');
    expect(canSend(after, { class: 'marketing', kind: 'manual', now, settings: defaultSettings() })).toEqual({ ok: false, reason: 'invalid' });
    expect(canSend(after, { class: 'order_required', kind: 'order_confirmation', now, settings: defaultSettings() })).toEqual({ ok: true });
  });

  it('a risky contact that soft-bounces once becomes hard-bounced', async () => {
    stubBouncer('risky');
    const c = await makeContact();
    await service().verifyContact(c.id, { source: 'signup_form' });
    expect((await contacts.get(c.id))!.bouncerResult).toBe('risky');
    expect(await contacts.recordDeliverability(c.id, 'soft_bounce')).toBe('hard_bounce');
  });

  it('unknown is retried once after 24 hours, then treated as risky', async () => {
    const seen = stubBouncer('unknown', 'unknown');
    const c = await makeContact();
    const t0 = new Date();
    await service().verifyContact(c.id, { source: 'checkout', now: t0 });
    expect((await contacts.get(c.id))!.bouncerResult).toBe('unknown');
    expect(await service().retryUnknown(new Date(t0.getTime() + 12 * 3_600_000))).toBe(0);
    await service().retryUnknown(new Date(t0.getTime() + 25 * 3_600_000));
    const after = (await contacts.get(c.id))!;
    expect(after.bouncerResult).toBe('risky');
    expect(after.bouncerReason).toMatch(/^unknown_after_retry/);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});

describe('reverifyDormant', () => {
  it('batch-checks contacts with no activity for a year and marks the dead ones invalid', async () => {
    const dormant = await makeContact();
    const active = await makeContact();
    const yearAgo = new Date(Date.now() - 400 * DAY);
    await getDb().update(emailContacts).set({ createdAt: yearAgo, lastOrderAt: yearAgo }).where(eq(emailContacts.id, dormant.id));
    await getDb().update(emailContacts).set({ createdAt: yearAgo, lastClickAt: new Date() }).where(eq(emailContacts.id, active.id));
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push(url);
        if (url.endsWith('/email/verify/batch')) {
          const sent = JSON.parse(String(init!.body)) as Array<{ email: string }>;
          expect(sent.map((s) => s.email)).toEqual([dormant.email]);
          return new Response(JSON.stringify({ batchId: 'b9' }));
        }
        if (url.endsWith('/batch/b9')) return new Response(JSON.stringify({ status: 'completed' }));
        return new Response(JSON.stringify([{ ...fx('undeliverable'), email: dormant.email }]));
      }),
    );
    const out = await service().reverifyDormant({ olderThanDays: 365, contactIds: [dormant.id, active.id] });
    expect(out).toEqual({ checked: 1, invalid: 1 });
    expect((await contacts.get(dormant.id))!.deliverability).toBe('invalid');
    expect((await contacts.get(active.id))!.deliverability).toBe('ok');
    expect(seen.every((u) => u.startsWith('https://bouncer.test/'))).toBe(true);
  });
});
