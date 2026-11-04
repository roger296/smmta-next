/**
 * The sender (spec § Sending pipeline; runbook section 6). Run by the
 * every-minute `email-send` job; safe to run in parallel.
 *
 *  1. Refuses to run at all when EMAIL_SEND_MODE is unset.
 *  2. Takes tokens from the rate limiter for as many due rows as it can send.
 *  3. Leases up to that many `queued` rows whose `not_before` has passed
 *     (FOR UPDATE SKIP LOCKED, pushing `not_before` 10 minutes on so a crashed
 *     run's rows come back by themselves).
 *  4. Per row: re-runs the gate (consent can change between queueing and
 *     sending; marketing also checks the UK send window), applies the
 *     allowlist in allowlist mode, renders, and calls SendGrid.
 *  5. 429 / 5xx / network: retried after 1, 4, 16 and 64 minutes, then
 *     dropped. Other 4xx: dropped with SendGrid's error body.
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getEnv } from '../../../config/env.js';
import { emailContacts, emailSends } from '../../../db/schema/index.js';
import { configuredSendMode, isAllowlisted, type SendMode } from '../lib/config.js';
import { canSend, nextWindowOpening } from '../lib/gate.js';
import { marketingHeaders } from '../lib/headers.js';
import { takeTokens } from '../lib/rate-limit.js';
import { buildPayload, SendGridError, SendGridTransport, type EmailTransport } from '../lib/sendgrid.js';
import { renderSend } from '../templates/render.js';
import { ContactsService } from './contacts.service.js';
import { getEmailSettings } from './settings.service.js';
import { unengagedStreak, type EmailSend } from './sends.service.js';

export const RETRY_MINUTES = [1, 4, 16, 64];
const LEASE_MS = 10 * 60_000;
const MINUTE_MS = 60_000;
const BATCH = 50;

export interface ProcessResult {
  refused?: 'send_mode_unset';
  sent: number;
  dropped: number;
  retried: number;
  deferred: number;
}

export interface ProcessOptions {
  now?: Date;
  limit?: number;
  transport?: EmailTransport;
  /** Defaults to EMAIL_SEND_MODE. */
  mode?: SendMode | null;
}

let defaultTransport: EmailTransport | undefined;
export function setTransportForTests(t: EmailTransport | undefined): void {
  defaultTransport = t;
}

export async function processQueue(opts: ProcessOptions = {}): Promise<ProcessResult> {
  const result: ProcessResult = { sent: 0, dropped: 0, retried: 0, deferred: 0 };
  const mode = opts.mode === undefined ? configuredSendMode() : opts.mode;
  if (!mode) return { ...result, refused: 'send_mode_unset' };
  const now = opts.now ?? new Date();
  const db = getDb();
  const settings = await getEmailSettings();
  const limit = Math.min(opts.limit ?? BATCH, BATCH);

  const [{ due } = { due: 0 }] = await db
    .select({ due: sql<number>`count(*)::int` })
    .from(emailSends)
    .where(and(eq(emailSends.status, 'queued'), lte(emailSends.notBefore, now)));
  if (due === 0) return result;
  const tokens = await takeTokens(Math.min(due, limit), settings.rate_limit_per_hour, now);
  if (tokens === 0) return result;

  // Lease rows: push not_before past now so no other run picks them up.
  const leased = await db.transaction(async (tx) => {
    const ids = await tx.execute(sql`
      SELECT id FROM email_sends
      WHERE status = 'queued' AND not_before <= ${now}
      ORDER BY not_before, created_at
      LIMIT ${tokens}
      FOR UPDATE SKIP LOCKED`);
    const list = (ids.rows as Array<{ id: string }>).map((r) => r.id);
    if (list.length === 0) return [] as EmailSend[];
    return tx
      .update(emailSends)
      .set({ notBefore: new Date(now.getTime() + LEASE_MS), attempts: sql`${emailSends.attempts} + 1`, updatedAt: now })
      .where(inArray(emailSends.id, list))
      .returning();
  });

  const transport = opts.transport ?? defaultTransport ?? new SendGridTransport();
  const contacts = new ContactsService();
  const env = getEnv();

  for (const send of leased) {
    const finish = async (patch: Partial<typeof emailSends.$inferInsert>) => {
      await db.update(emailSends).set({ ...patch, updatedAt: new Date() }).where(eq(emailSends.id, send.id));
    };
    const contact = await contacts.get(send.contactId);
    if (!contact) {
      await finish({ status: 'dropped', dropReason: 'no_contact' });
      result.dropped++;
      continue;
    }

    const campaign = send.campaignId
      ? (await db.execute(sql`select override_gap from email_campaigns where id = ${send.campaignId}`)).rows[0]
      : undefined;
    const verdict = canSend(contact, {
      class: send.class,
      kind: send.kind,
      now,
      settings,
      checkWindow: true,
      overrideGap: Boolean((campaign as { override_gap?: boolean } | undefined)?.override_gap),
      unengagedStreak: send.class === 'marketing' ? await unengagedStreak(contact, settings.unengaged_limit) : 0,
    });
    if (!verdict.ok) {
      if (verdict.reason === 'window') {
        await finish({ notBefore: nextWindowOpening(now, settings.send_window), attempts: send.attempts - 1 });
        result.deferred++;
      } else if (verdict.reason === 'paused') {
        // Paused marketing waits; it is not lost.
        await finish({ notBefore: new Date(now.getTime() + 15 * MINUTE_MS), attempts: send.attempts - 1 });
        result.deferred++;
      } else {
        await finish({ status: 'dropped', dropReason: verdict.reason });
        result.dropped++;
      }
      continue;
    }

    if (mode === 'allowlist' && !isAllowlisted(contact.email)) {
      await finish({ status: 'dropped', dropReason: 'not_in_allowlist' });
      result.dropped++;
      continue;
    }

    let rendered;
    try {
      rendered = await renderSend(send, contact);
    } catch (err) {
      await finish({ status: 'dropped', dropReason: 'render_failed', error: err instanceof Error ? err.message : String(err) });
      result.dropped++;
      continue;
    }

    const payload = buildPayload(
      {
        to: contact.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        sendId: send.id,
        campaignId: send.campaignId,
        contactId: contact.id,
        class: send.class,
        kind: send.kind,
        headers: send.class === 'marketing' ? marketingHeaders(contact) : undefined,
        fromName: settings.from_name || env.EMAIL_FROM_NAME,
        fromAddress: env.EMAIL_FROM_ADDRESS,
        replyTo: settings.reply_to || env.EMAIL_REPLY_TO,
      },
      mode,
    );

    try {
      const { messageId } = await transport.send(payload);
      const sentAt = new Date();
      await finish({ status: 'sent', sentAt, sendgridMessageId: messageId, subject: rendered.subject, error: null });
      if (send.class === 'marketing') {
        await db
          .update(emailContacts)
          .set({
            lastMarketingAt: sentAt,
            ...(send.kind === 'weekly_digest' ? { lastDigestAt: sentAt } : {}),
          })
          .where(eq(emailContacts.id, contact.id));
      }
      result.sent++;
    } catch (err) {
      const sg = err instanceof SendGridError ? err : new SendGridError(String(err), 0, true, '');
      if (sg.retryable && send.attempts <= RETRY_MINUTES.length) {
        const wait = RETRY_MINUTES[send.attempts - 1]!;
        await finish({ notBefore: new Date(now.getTime() + wait * MINUTE_MS), error: `${sg.message} ${sg.body}`.trim() });
        result.retried++;
      } else {
        await finish({
          status: 'dropped',
          dropReason: sg.retryable ? 'provider_retries_exhausted' : 'provider_rejected',
          error: `${sg.message} ${sg.body}`.trim(),
        });
        result.dropped++;
      }
    }
  }
  return result;
}
