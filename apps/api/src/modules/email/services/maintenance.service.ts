/**
 * Nightly safety nets (spec § Sending pipeline → Safety net; runbook
 * section 6 item 6).
 *
 *  - reconcileSuppressions: pull SendGrid's bounces, spam reports, invalid
 *    addresses and global / group unsubscribes for the last two days and
 *    apply any the webhook missed to contacts we hold.
 *  - deliverabilityCheck: 7-day bounce and complaint rates by class; when
 *    marketing passes the thresholds (complaints ≥ 0.2% or bounces ≥ 3%, at
 *    least 200 sends) marketing pauses itself, an alert row is written and the
 *    alert address is emailed.
 *  - pruneEvents: raw webhook events older than 13 months are deleted.
 */
import { and, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getEnv } from '../../../config/env.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import { emailAlerts, emailEvents, emailSends, emailSettings, type EmailClass } from '../../../db/schema/index.js';
import { getSendGrid } from '../../../integrations/sendgrid/sendgrid.js';
import { normaliseEmail } from '../lib/normalise.js';
import { ContactsService } from './contacts.service.js';
import { getEmailSettings, updateEmailSettings } from './settings.service.js';

const DAY_MS = 86_400_000;

export type SuppressionKind = 'bounces' | 'spam_reports' | 'invalid_emails' | 'unsubscribes' | 'group_unsubscribes';

/** Reads SendGrid's suppression lists. A port so tests need no network. */
export interface SuppressionSource {
  list(kind: SuppressionKind, since: Date): Promise<string[]>;
}

export class SendGridSuppressionSource implements SuppressionSource {
  constructor(private readonly apiKey = getEnv().SENDGRID_API_KEY) {}

  async list(kind: SuppressionKind, since: Date): Promise<string[]> {
    if (!this.apiKey) return [];
    const path =
      kind === 'group_unsubscribes'
        ? '/v3/asm/suppressions'
        : `/v3/suppression/${kind === 'unsubscribes' ? 'unsubscribes' : kind}`;
    const out: string[] = [];
    for (let offset = 0; offset < 50_000; offset += 500) {
      const qs = kind === 'group_unsubscribes' ? '' : `?start_time=${Math.floor(since.getTime() / 1000)}&limit=500&offset=${offset}`;
      const res = await fetch(`https://api.sendgrid.com${path}${qs}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`SendGrid ${path} ${res.status}`);
      const rows = (await res.json()) as Array<{ email?: string; created?: number; created_at?: number }>;
      for (const r of rows) {
        const created = r.created ?? r.created_at;
        if (r.email && (kind !== 'group_unsubscribes' || !created || created * 1000 >= since.getTime())) out.push(r.email);
      }
      if (kind === 'group_unsubscribes' || rows.length < 500) break;
    }
    return out;
  }
}

export interface ReconcileResult {
  checked: number;
  applied: number;
}

export interface ClassRates {
  class: EmailClass;
  sent: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
}

export class MaintenanceService {
  private contacts = new ContactsService();

  async reconcileSuppressions(source: SuppressionSource = new SendGridSuppressionSource(), now = new Date()): Promise<ReconcileResult> {
    const since = new Date(now.getTime() - 2 * DAY_MS);
    const result: ReconcileResult = { checked: 0, applied: 0 };
    const kinds: SuppressionKind[] = ['bounces', 'spam_reports', 'invalid_emails', 'unsubscribes', 'group_unsubscribes'];
    for (const kind of kinds) {
      for (const raw of await source.list(kind, since)) {
        result.checked++;
        const c = await this.contacts.getByEmail(normaliseEmail(raw));
        if (!c) continue;
        let changed = false;
        if (kind === 'bounces' && c.deliverability !== 'hard_bounce' && c.deliverability !== 'complained') {
          await this.contacts.recordDeliverability(c.id, 'hard_bounce', now);
          changed = true;
        }
        if (kind === 'spam_reports' && c.deliverability !== 'complained') {
          await this.contacts.recordDeliverability(c.id, 'complained', now);
          changed = true;
        }
        if (kind === 'invalid_emails' && c.deliverability === 'ok') {
          await this.contacts.recordDeliverability(c.id, 'invalid', now);
          changed = true;
        }
        if (c.marketingStatus === 'all' && kind !== 'invalid_emails') {
          await this.contacts.setMarketingStatus(c.id, 'transactional_only', {
            source: kind === 'spam_reports' ? 'complaint_webhook' : 'reconcile',
            actor: 'system',
            reason: `SendGrid ${kind.replace('_', ' ')} list`,
          });
          changed = true;
        }
        if (changed) result.applied++;
      }
    }
    // Shown on the Deliverability page: when the safety net last ran.
    await getDb()
      .insert(emailSettings)
      .values({ key: 'status_last_reconcile', value: { ...result }, updatedBy: 'system' })
      .onConflictDoUpdate({ target: emailSettings.key, set: { value: { ...result }, updatedAt: now } });
    return result;
  }

  /** Bounce and complaint rates per class over the last `days`. */
  async rates(days: number, now = new Date()): Promise<ClassRates[]> {
    const since = new Date(now.getTime() - days * DAY_MS);
    const rows = await getDb()
      .select({
        class: emailSends.class,
        sent: sql<number>`count(*)::int`,
        bounced: sql<number>`count(*) filter (where ${emailSends.status} = 'bounced')::int`,
        complained: sql<number>`count(*) filter (where ${emailSends.status} = 'complained')::int`,
      })
      .from(emailSends)
      .where(and(isNotNull(emailSends.sentAt), gte(emailSends.sentAt, since)))
      .groupBy(emailSends.class);
    return rows.map((r) => ({
      ...r,
      bounceRate: r.sent ? r.bounced / r.sent : 0,
      complaintRate: r.sent ? r.complained / r.sent : 0,
    }));
  }

  async deliverabilityCheck(now = new Date()): Promise<{ paused: boolean; rates: ClassRates[] }> {
    const settings = await getEmailSettings();
    const { complaint_rate, bounce_rate, min_sends, days } = settings.auto_pause;
    const rates = await this.rates(days, now);
    const m = rates.find((r) => r.class === 'marketing');
    if (!m || m.sent < min_sends || settings.marketing_paused) return { paused: false, rates };
    const reasons: string[] = [];
    if (m.complaintRate >= complaint_rate) reasons.push(`complaints ${(m.complaintRate * 100).toFixed(2)}% (limit ${(complaint_rate * 100).toFixed(2)}%)`);
    if (m.bounceRate >= bounce_rate) reasons.push(`bounces ${(m.bounceRate * 100).toFixed(2)}% (limit ${(bounce_rate * 100).toFixed(2)}%)`);
    if (reasons.length === 0) return { paused: false, rates };

    const message = `Marketing email paused itself: ${reasons.join(' and ')} over the last ${days} days (${m.sent} sends).`;
    await updateEmailSettings({ marketing_paused: true, marketing_paused_reason: message }, 'system');
    await getDb().insert(emailAlerts).values({ companyId: getSingletonCompanyId(), kind: 'auto_pause', message, detail: { rates } });
    const env = getEnv();
    const to = env.EMAIL_ALERT_EMAIL || env.SUPPLIER_ORDER_ALERT_EMAIL;
    if (to) {
      try {
        // Staff alert through the platform's existing internal-mail path
        // (integrations/sendgrid), not the customer pipeline it is about.
        await getSendGrid().send({
          to,
          category: 'transactional',
          subject: 'Marketing email has paused itself',
          html: `<p>${message}</p><p>Resume it from Messaging → Deliverability once the cause is understood.</p>`,
          idempotencyKey: `email-auto-pause:${now.toISOString().slice(0, 10)}`,
        });
      } catch {
        // The alert row and the paused state are the record; mail is a courtesy.
      }
    }
    return { paused: true, rates };
  }

  async pruneEvents(now = new Date()): Promise<number> {
    const { event_retention_months } = await getEmailSettings();
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - event_retention_months);
    const rows = await getDb().delete(emailEvents).where(lt(emailEvents.receivedAt, cutoff)).returning({ id: emailEvents.id });
    return rows.length;
  }
}
