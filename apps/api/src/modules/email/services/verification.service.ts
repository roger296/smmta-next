/**
 * Address verification (spec § Address verification with Bouncer; runbook
 * section 5).
 *
 *  - A contact created by checkout, a signup form, a back-in-stock request, a
 *    pre-order or a subscription emits `email.contact_created` in the same
 *    transaction; the worker's `email-verify` job checks it with Bouncer. The
 *    request that created the contact never waits.
 *  - Imports, the backfill and admin / MCP additions are not verified.
 *  - A result is good for 90 days (setting bouncer_cache_days).
 *  - undeliverable → deliverability `invalid` (order-required mail still goes;
 *    its bounce confirms the verdict). risky → stored; its first soft bounce
 *    becomes a hard bounce (contacts.service). unknown → checked once more
 *    after 24 hours, then treated as risky.
 *  - Before a win-back, dormant contacts are re-verified in one batch.
 */
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { emailContacts } from '../../../db/schema/index.js';
import { BouncerClient, type BouncerResult } from '../lib/bouncer.js';
import { ContactsService, VERIFY_SOURCES } from './contacts.service.js';
import { getEmailSettings } from './settings.service.js';

export { VERIFY_SOURCES };

const DAY_MS = 86_400_000;

export type VerifyOutcome =
  | { status: 'skipped'; reason: 'not_found' | 'fresh' | 'not_configured' | 'source' }
  | { status: 'verified'; result: BouncerResult['status'] };

export class VerificationService {
  private contacts = new ContactsService();

  constructor(private readonly bouncer: BouncerClient = new BouncerClient()) {}

  /** Apply one Bouncer verdict to a contact. */
  async apply(contactId: string, result: Pick<BouncerResult, 'status' | 'reason'>, now = new Date(), retried = false): Promise<void> {
    const db = getDb();
    const stored = result.status === 'unknown' && retried ? 'risky' : result.status;
    await db
      .update(emailContacts)
      .set({
        bouncerResult: stored,
        bouncerReason: stored !== result.status ? `unknown_after_retry${result.reason ? `:${result.reason}` : ''}` : result.reason,
        bouncerCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(emailContacts.id, contactId));
    if (stored === 'undeliverable') await this.contacts.recordDeliverability(contactId, 'invalid', now);
  }

  /** The `email-verify` job: verify one contact unless it is fresh. */
  async verifyContact(contactId: string, opts: { source?: string; now?: Date; force?: boolean } = {}): Promise<VerifyOutcome> {
    const now = opts.now ?? new Date();
    if (opts.source && !(VERIFY_SOURCES as readonly string[]).includes(opts.source)) {
      return { status: 'skipped', reason: 'source' };
    }
    const contact = await this.contacts.get(contactId);
    if (!contact) return { status: 'skipped', reason: 'not_found' };
    const { bouncer_cache_days } = await getEmailSettings();
    if (
      !opts.force &&
      contact.bouncerCheckedAt &&
      contact.bouncerResult !== 'unknown' &&
      now.getTime() - contact.bouncerCheckedAt.getTime() < bouncer_cache_days * DAY_MS
    ) {
      return { status: 'skipped', reason: 'fresh' };
    }
    if (!this.bouncer.configured) return { status: 'skipped', reason: 'not_configured' };
    const result = await this.bouncer.verify(contact.email);
    await this.apply(contactId, result, now, contact.bouncerResult === 'unknown');
    return { status: 'verified', result: result.status };
  }

  /** Daily: contacts still `unknown` after 24 hours get their one retry. */
  async retryUnknown(now = new Date()): Promise<number> {
    const rows = await getDb()
      .select({ id: emailContacts.id })
      .from(emailContacts)
      .where(and(eq(emailContacts.bouncerResult, 'unknown'), lt(emailContacts.bouncerCheckedAt, new Date(now.getTime() - DAY_MS))))
      .limit(1000);
    let n = 0;
    for (const r of rows) {
      const out = await this.verifyContact(r.id, { now, force: true });
      if (out.status === 'verified') n++;
    }
    return n;
  }

  /**
   * Batch re-verify contacts with no click, open or order in `olderThanDays`
   * (and no check in the cache window), waiting for the batch. Used before a
   * win-back. Returns how many were checked and how many proved invalid.
   */
  async reverifyDormant(opts: { olderThanDays?: number; contactIds?: string[]; now?: Date } = {}): Promise<{ checked: number; invalid: number }> {
    const now = opts.now ?? new Date();
    const { bouncer_cache_days } = await getEmailSettings();
    const dormantBefore = new Date(now.getTime() - (opts.olderThanDays ?? 365) * DAY_MS);
    const freshAfter = new Date(now.getTime() - bouncer_cache_days * DAY_MS);
    const lastActivity = sql`greatest(coalesce(${emailContacts.lastClickAt}, 'epoch'), coalesce(${emailContacts.lastOpenAt}, 'epoch'), coalesce(${emailContacts.lastOrderAt}, 'epoch'), ${emailContacts.createdAt})`;
    const conditions = [
      sql`${lastActivity} < ${dormantBefore}`,
      inArray(emailContacts.deliverability, ['ok', 'soft_bounce']),
      or(isNull(emailContacts.bouncerCheckedAt), lt(emailContacts.bouncerCheckedAt, freshAfter)),
    ];
    if (opts.contactIds) conditions.push(inArray(emailContacts.id, opts.contactIds.length ? opts.contactIds : ['00000000-0000-0000-0000-000000000000']));
    const rows = await getDb().select({ id: emailContacts.id, email: emailContacts.email }).from(emailContacts).where(and(...conditions));
    if (rows.length === 0 || !this.bouncer.configured) return { checked: 0, invalid: 0 };
    const results = await this.bouncer.verifyBatch(rows.map((r) => r.email));
    const byEmail = new Map(results.map((r) => [r.email.toLowerCase(), r]));
    let invalid = 0;
    for (const r of rows) {
      const res = byEmail.get(r.email);
      if (!res) continue;
      await this.apply(r.id, res, now, true);
      if (res.status === 'undeliverable') invalid++;
    }
    return { checked: rows.length, invalid };
  }
}
