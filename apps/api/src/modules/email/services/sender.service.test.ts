/**
 * The sender (runbook section 6): pacing under the rate limit, the gate at
 * send time, the allowlist, the send window and retries. The SendGrid
 * transport is a fake; other suites' leftover queued rows are set aside first,
 * because the queue is global.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { emailContacts, emailSends } from '../../../db/schema/index.js';
import { resetBucket } from '../lib/rate-limit.js';
import { SendGridError, type EmailTransport } from '../lib/sendgrid.js';
import { ContactsService } from './contacts.service.js';
import { processQueue } from './sender.service.js';
import { SendsService } from './sends.service.js';
import { makeContact, setEnvAllowlist, withSettings } from '../testing.js';

const sends = new SendsService();
const contacts = new ContactsService();
let restore: (() => Promise<void>) | undefined;

class FakeTransport implements EmailTransport {
  payloads: Array<Record<string, any>> = [];
  failures: Error[] = [];
  async send(payload: Record<string, unknown>) {
    const f = this.failures.shift();
    if (f) throw f;
    this.payloads.push(payload as Record<string, any>);
    return { messageId: `msg-${this.payloads.length}` };
  }
}

async function isolateQueue() {
  await getDb().update(emailSends).set({ status: 'dropped', dropReason: 'test_isolation' }).where(eq(emailSends.status, 'queued'));
  await resetBucket();
}

beforeEach(isolateQueue);
afterAll(async () => {
  await restore?.();
  await resetBucket();
});

const T0 = new Date('2026-11-05T10:00:00Z'); // Thursday 10:00 UK, inside the window
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

async function queue(contactId: string, n: number, cls: 'requested_service' | 'marketing' = 'requested_service', tag = Math.random().toString(36).slice(2)) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { send } = await sends.enqueue({ contactId, class: cls, kind: cls === 'marketing' ? 'manual' : 'back_in_stock', templateKey: 'back_in_stock', idempotencyKey: `t:${tag}:${i}`, data: { items: [] }, now: T0 });
    ids.push(send.id);
  }
  return ids;
}

const statuses = async (ids: string[]) =>
  (await getDb().select({ status: emailSends.status }).from(emailSends).where(inArray(emailSends.id, ids))).map((r) => r.status);

describe('processQueue', () => {
  it('refuses to run when EMAIL_SEND_MODE is unset', async () => {
    expect(await processQueue({ mode: null })).toMatchObject({ refused: 'send_mode_unset' });
  });

  it('sends 120 rows at 60 an hour: 60 in the first hour, 60 in the second', async () => {
    restore = await withSettings({ rate_limit_per_hour: 60 });
    const c = await makeContact();
    const ids = await queue(c.id, 120);
    const transport = new FakeTransport();
    let firstHour = 0;
    for (let m = 0; m < 120; m++) {
      const r = await processQueue({ now: minutes(m), mode: 'sandbox', transport });
      if (m < 60) firstHour += r.sent;
    }
    expect(firstHour).toBe(60);
    expect(transport.payloads).toHaveLength(120);
    expect((await statuses(ids)).every((s) => s === 'sent')).toBe(true);
    expect(transport.payloads[0]!.mail_settings.sandbox_mode.enable).toBe(true);
    await restore();
    restore = undefined;
  });

  it('drops a row the gate refuses at send time', async () => {
    const c = await makeContact({ initialStatus: 'transactional_only' });
    const [id] = await queue(c.id, 1);
    await contacts.setMarketingStatus(c.id, 'never', { source: 'admin_ui', actor: 'u', reason: 'asked', confirm: true });
    const transport = new FakeTransport();
    const r = await processQueue({ now: minutes(1), mode: 'sandbox', transport });
    expect(r).toMatchObject({ sent: 0, dropped: 1 });
    const [row] = await getDb().select().from(emailSends).where(eq(emailSends.id, id!));
    expect(row).toMatchObject({ status: 'dropped', dropReason: 'never' });
    expect(transport.payloads).toHaveLength(0);
  });

  it('retries a 429 and sends once', async () => {
    const c = await makeContact();
    const [id] = await queue(c.id, 1);
    const transport = new FakeTransport();
    transport.failures.push(new SendGridError('SendGrid 429', 429, true, 'slow down'));
    expect(await processQueue({ now: minutes(0), mode: 'sandbox', transport })).toMatchObject({ retried: 1, sent: 0 });
    let [row] = await getDb().select().from(emailSends).where(eq(emailSends.id, id!));
    expect(row!.status).toBe('queued');
    expect(row!.notBefore.getTime()).toBe(minutes(1).getTime());
    expect(row!.error).toContain('429');
    expect(await processQueue({ now: minutes(1), mode: 'sandbox', transport })).toMatchObject({ sent: 1 });
    [row] = await getDb().select().from(emailSends).where(eq(emailSends.id, id!));
    expect(row).toMatchObject({ status: 'sent', attempts: 2, sendgridMessageId: 'msg-1' });
    expect(transport.payloads).toHaveLength(1);
  });

  it('drops after the last retry, and at once on a permanent error', async () => {
    const c = await makeContact();
    const [a, b] = await queue(c.id, 2);
    const transport = new FakeTransport();
    transport.failures.push(new SendGridError('SendGrid 400', 400, false, 'bad from'));
    await processQueue({ now: minutes(0), mode: 'sandbox', transport, limit: 1 });
    const [ra] = await getDb().select().from(emailSends).where(eq(emailSends.id, a!));
    expect(ra).toMatchObject({ status: 'dropped', dropReason: 'provider_rejected' });
    let at = 1;
    for (const wait of [0, 1, 4, 16, 64]) {
      at += wait;
      transport.failures.push(new SendGridError('SendGrid 503', 503, true, ''));
      await processQueue({ now: minutes(at), mode: 'sandbox', transport });
    }
    const [rb] = await getDb().select().from(emailSends).where(eq(emailSends.id, b!));
    expect(rb).toMatchObject({ status: 'dropped', dropReason: 'provider_retries_exhausted', attempts: 5 });
  });

  it('in allowlist mode holds marketing to listed addresses but lets back in stock reach everyone', async () => {
    const listed = await makeContact({ email: `allow-${Date.now()}@example.com`, initialStatus: 'all' });
    const other = await makeContact({ initialStatus: 'all' });
    const undo = setEnvAllowlist(listed.email);
    const [x] = await queue(listed.id, 1, 'marketing');
    const [y] = await queue(other.id, 1, 'marketing');
    const [z] = await queue(other.id, 1, 'requested_service');
    const transport = new FakeTransport();
    await processQueue({ now: minutes(0), mode: 'allowlist', transport });
    undo();
    expect(await statuses([x!])).toEqual(['sent']);
    const [ry] = await getDb().select().from(emailSends).where(eq(emailSends.id, y!));
    expect(ry).toMatchObject({ status: 'dropped', dropReason: 'not_in_allowlist' });
    expect(await statuses([z!])).toEqual(['sent']);
    expect(transport.payloads.map((p) => p.mail_settings.sandbox_mode.enable)).toEqual([false, false]);
  });

  it('holds marketing until the send window opens and adds the unsubscribe headers', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    const night = new Date('2026-11-05T21:00:00Z');
    const { send } = await sends.enqueue({ contactId: c.id, class: 'marketing', kind: 'manual', templateKey: 'manual', idempotencyKey: `win:${c.id}`, now: night });
    const transport = new FakeTransport();
    expect(await processQueue({ now: night, mode: 'sandbox', transport })).toMatchObject({ deferred: 1 });
    const [held] = await getDb().select().from(emailSends).where(eq(emailSends.id, send.id));
    expect(held!.notBefore.toISOString()).toBe('2026-11-06T08:00:00.000Z');
    expect(held!.status).toBe('queued');
    await processQueue({ now: new Date('2026-11-06T08:00:00Z'), mode: 'sandbox', transport });
    expect(transport.payloads).toHaveLength(1);
    expect(transport.payloads[0]!.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const [after] = await getDb().select().from(emailContacts).where(eq(emailContacts.id, c.id));
    expect(after!.lastMarketingAt).not.toBeNull();
  });
});
