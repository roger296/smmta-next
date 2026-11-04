/**
 * What an operator — a person in the admin, or Claude through MCP — can do
 * with the email system. The admin routes and the MCP tools both call these,
 * so nothing is possible in one that is not in the other (approval aside,
 * which the callers gate).
 */
import { and, desc, eq, gte, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import {
  customerOrders,
  customers,
  emailAudit,
  emailConsentEvents,
  emailContacts,
  emailSends,
  emailWeeklyContent,
} from '../../../db/schema/index.js';
import { configuredSendMode, displaySendMode, isAllowlisted, testAllowlist } from '../lib/config.js';
import { effectiveScore, MATERIAL_KEYS } from '../lib/interests.js';
import { maskEmail, normaliseEmail } from '../lib/normalise.js';
import { bucketState } from '../lib/rate-limit.js';
import { buildPayload, SendGridTransport, type EmailTransport } from '../lib/sendgrid.js';
import { marketingHeaders } from '../lib/headers.js';
import { getEnv } from '../../../config/env.js';
import { renderTemplate } from '../templates/render.js';
import type { Block } from '../templates/blocks.js';
import { policyFrom } from './audience.service.js';
import { CampaignsService } from './campaigns.service.js';
import { ContactsService, type Contact } from './contacts.service.js';
import { MaintenanceService } from './maintenance.service.js';
import { ReportsService } from './reports.service.js';
import { getEmailSettings, updateEmailSettings } from './settings.service.js';
import { weekStartOf } from './digest.service.js';

export const contactFilterSchema = z
  .object({
    search: z.string().max(200).optional(),
    status: z.enum(['all', 'transactional_only', 'never']).optional(),
    deliverability: z.enum(['ok', 'soft_bounce', 'hard_bounce', 'complained', 'invalid']).optional(),
    interest: z.string().optional(),
    is_trade: z.boolean().optional(),
    engaged_within_days: z.number().int().positive().optional(),
    last_order_within_days: z.number().int().positive().optional(),
    source: z.string().optional(),
    page: z.number().int().min(1).default(1),
    page_size: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ContactFilter = z.input<typeof contactFilterSchema>;

const DAY_MS = 86_400_000;

/** Replace anything that looks like an address with its masked form. */
export function maskDeep(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/[^\s@<>(),;:"']+@[^\s@<>(),;:"']+/g, (m) => maskEmail(m));
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
}

export async function audit(tool: string, actor: string, args: unknown, ok: boolean, summary: string): Promise<void> {
  await getDb().insert(emailAudit).values({
    companyId: getSingletonCompanyId(),
    tool,
    actor,
    args: maskDeep(args) as Record<string, unknown>,
    ok,
    summary: summary.slice(0, 2000),
  });
}

export class OperatorService {
  private contacts = new ContactsService();
  private reports = new ReportsService();
  private campaigns = new CampaignsService();

  async listContacts(filterIn: ContactFilter) {
    const f = contactFilterSchema.parse(filterIn);
    const settings = await getEmailSettings();
    const now = new Date();
    const w: SQL[] = [];
    if (f.search) w.push(ilike(emailContacts.email, `%${f.search.trim().toLowerCase()}%`));
    if (f.status) w.push(eq(emailContacts.marketingStatus, f.status));
    if (f.deliverability) w.push(eq(emailContacts.deliverability, f.deliverability));
    if (f.is_trade !== undefined) w.push(eq(emailContacts.isTrade, f.is_trade));
    if (f.source) w.push(eq(emailContacts.consentSource, f.source));
    if (f.last_order_within_days) w.push(gte(emailContacts.lastOrderAt, new Date(now.getTime() - f.last_order_within_days * DAY_MS)));
    if (f.engaged_within_days) {
      const since = new Date(now.getTime() - f.engaged_within_days * DAY_MS);
      w.push(sql`(${emailContacts.lastClickAt} >= ${since} or ${emailContacts.lastOrderAt} >= ${since})`);
    }
    if (f.interest) w.push(sql`${emailContacts.interests} ? ${f.interest}`);
    const where = w.length ? and(...w) : undefined;
    const [{ total } = { total: 0 }] = await getDb().select({ total: sql<number>`count(*)::int` }).from(emailContacts).where(where);
    const rows = await getDb()
      .select()
      .from(emailContacts)
      .where(where)
      .orderBy(desc(emailContacts.updatedAt))
      .limit(f.page_size)
      .offset((f.page - 1) * f.page_size);
    const policy = policyFrom(settings);
    return {
      total,
      page: f.page,
      pageSize: f.page_size,
      contacts: rows.map((c) => ({
        id: c.id,
        email: c.email,
        marketingStatus: c.marketingStatus,
        deliverability: c.deliverability,
        isTrade: c.isTrade,
        consentSource: c.consentSource,
        interests: Object.keys(c.interests).filter((k) => effectiveScore(c.interests[k], now, policy) >= policy.threshold),
        lastOrderAt: c.lastOrderAt,
        lastClickAt: c.lastClickAt,
        lastMarketingAt: c.lastMarketingAt,
        customerId: c.customerId,
      })),
    };
  }

  async getContact(id: string) {
    const c = await this.contacts.get(id);
    if (!c) return null;
    const settings = await getEmailSettings();
    const policy = policyFrom(settings);
    const now = new Date();
    const consent = await getDb().select().from(emailConsentEvents).where(eq(emailConsentEvents.contactId, id)).orderBy(desc(emailConsentEvents.createdAt));
    const timeline = await this.reports.contactTimeline(id, { limit: 50 });
    const [orders] = c.customerId
      ? await getDb()
          .select({ n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${customerOrders.grandTotal}), 0)` })
          .from(customerOrders)
          .innerJoin(customers, eq(customers.id, customerOrders.customerId))
          .where(eq(customers.contactId, id))
      : [{ n: 0, total: '0' }];
    return {
      contact: { ...c, unsubscribeToken: undefined },
      interests: Object.fromEntries(Object.entries(c.interests).map(([k, v]) => [k, Math.round(effectiveScore(v, now, policy) * 10) / 10])),
      consentEvents: consent,
      timeline,
      orders: { count: Number(orders?.n ?? 0), totalGbp: Number(orders?.total ?? 0) },
    };
  }

  /** Consent gathered somewhere else (a trade show, a phone call). */
  async recordConsent(email: string, input: { source: string; evidence: string; status: 'all' | 'transactional_only' }, actor: string, via: 'mcp' | 'admin_ui') {
    const { contact } = await this.contacts.findOrCreateByEmail(email, { source: via === 'mcp' ? 'mcp' : 'admin', actor });
    const res = await this.contacts.setMarketingStatus(contact.id, input.status, {
      source: via,
      actor,
      reason: `${input.source}: ${input.evidence}`,
      confirm: true,
      evidence: { gathered: input.source, note: input.evidence },
    });
    return { contactId: contact.id, ...res };
  }

  async writeWeeklyContent(input: { key: string; kind: 'featured' | 'deal'; body: string; title?: string; url?: string; priceGbp?: string; savingGbp?: string; week?: string }, actor: string) {
    if (input.key !== 'all' && !MATERIAL_KEYS.includes(input.key) && !input.key.startsWith('category:')) {
      throw new Error(`unknown interest key ${input.key}; use one of ${MATERIAL_KEYS.join(', ')} or all`);
    }
    const weekStart = input.week ?? weekStartOf(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error('week must be YYYY-MM-DD (the Monday)');
    if (input.kind === 'featured') {
      // One featured paragraph per key per week: the latest replaces it.
      await getDb().delete(emailWeeklyContent).where(and(eq(emailWeeklyContent.weekStart, weekStart), eq(emailWeeklyContent.key, input.key), eq(emailWeeklyContent.kind, 'featured')));
    }
    const [row] = await getDb()
      .insert(emailWeeklyContent)
      .values({ companyId: getSingletonCompanyId(), weekStart, key: input.key, kind: input.kind, title: input.title, body: input.body, url: input.url, priceGbp: input.priceGbp, savingGbp: input.savingGbp, createdBy: actor })
      .returning();
    return row!;
  }

  /**
   * Send a campaign to test addresses. Only addresses on EMAIL_TEST_ALLOWLIST;
   * never the gate (it is a test), but always the send mode: in sandbox (or
   * unset) mode SendGrid accepts it and delivers nothing.
   */
  async sendTest(campaignId: string, emails: string[], actor: string, transport: EmailTransport = new SendGridTransport()) {
    const campaign = await this.campaigns.get(campaignId);
    const refused = emails.filter((e) => !isAllowlisted(e));
    if (refused.length) throw new Error(`not on the test allowlist: ${refused.map(maskEmail).join(', ')} (allowed: ${testAllowlist().map(maskEmail).join(', ') || 'none set'})`);
    const settings = await getEmailSettings();
    const env = getEnv();
    const mode = configuredSendMode() === 'sandbox' || !configuredSendMode() ? 'sandbox' : 'live';
    const results: Array<{ email: string; messageId: string }> = [];
    for (const raw of emails) {
      const { contact } = await this.contacts.findOrCreateByEmail(raw, { source: 'admin', actor });
      const [row] = await getDb()
        .insert(emailSends)
        .values({
          companyId: getSingletonCompanyId(),
          campaignId,
          contactId: contact.id,
          class: campaign.class,
          kind: 'test',
          templateKey: campaign.templateKey,
          idempotencyKey: `test:${campaignId}:${contact.id}:${Date.now()}`,
          status: 'queued',
          notBefore: new Date('9999-01-01'), // never picked up by the sender
        })
        .returning();
      const r = await renderTemplate({
        templateKey: campaign.templateKey,
        cls: campaign.class,
        kind: campaign.kind,
        data: {},
        contact,
        sendId: row!.id,
        campaign: { id: campaign.id, subject: campaign.subject, preheader: campaign.preheader, content: campaign.content as Block[], utmCampaign: campaign.utmCampaign },
      });
      const payload = buildPayload(
        {
          to: contact.email,
          subject: `[TEST] ${r.subject}`,
          html: r.html,
          text: r.text,
          sendId: row!.id,
          campaignId,
          contactId: contact.id,
          class: campaign.class,
          kind: 'test',
          headers: campaign.class === 'marketing' ? marketingHeaders(contact) : undefined,
          fromName: settings.from_name || env.EMAIL_FROM_NAME,
          fromAddress: env.EMAIL_FROM_ADDRESS,
          replyTo: settings.reply_to || env.EMAIL_REPLY_TO,
        },
        mode,
      );
      const { messageId } = await transport.send(payload);
      await getDb().update(emailSends).set({ status: 'sent', sentAt: new Date(), sendgridMessageId: messageId, subject: `[TEST] ${r.subject}` }).where(eq(emailSends.id, row!.id));
      results.push({ email: contact.email, messageId });
    }
    return { mode, sent: results };
  }

  async setMarketingPaused(paused: boolean, actor: string, reason = '') {
    const s = await updateEmailSettings({ marketing_paused: paused, marketing_paused_reason: paused ? reason || `paused by ${actor}` : '' }, actor);
    return { marketingPaused: s.marketing_paused, reason: s.marketing_paused_reason };
  }

  async deliverability() {
    const maintenance = new MaintenanceService();
    const settings = await getEmailSettings();
    const [last] = await getDb().select({ at: sql<Date | null>`max(${emailSends.sentAt})` }).from(emailSends);
    const lastEvent = (await getDb().execute(sql`select max(received_at) as at from email_events`)).rows[0] as { at: Date | null } | undefined;
    const lastReconcile = (await getDb().execute(sql`select value, updated_at from email_settings where key = 'status_last_reconcile'`)).rows[0] as { value: unknown; updated_at: Date } | undefined;
    return {
      sendMode: displaySendMode(),
      sendModeSet: configuredSendMode() !== null,
      marketingPaused: settings.marketing_paused,
      pausedReason: settings.marketing_paused_reason,
      rates7: await maintenance.rates(7),
      rates30: await maintenance.rates(30),
      thresholds: settings.auto_pause,
      lastSendAt: last?.at ?? null,
      lastWebhookEventAt: lastEvent?.at ?? null,
      lastReconcile: lastReconcile ? { at: lastReconcile.updated_at, result: lastReconcile.value } : null,
      rateLimit: { perHour: settings.rate_limit_per_hour, bucket: await bucketState() },
      queued: Number(((await getDb().execute(sql`select count(*)::int as n from email_sends where status = 'queued' and not_before < '9999-01-01'`)).rows[0] as { n: number }).n),
    };
  }

  async automations() {
    const settings = await getEmailSettings();
    const out = [];
    for (const [key, cfg] of Object.entries(settings.automations)) {
      out.push({ key, ...cfg, last30Days: await this.reports.automationReport(key, 30) });
    }
    return out;
  }

  async updateAutomation(key: string, patch: Record<string, unknown>, actor: string) {
    const settings = await getEmailSettings();
    if (!settings.automations[key]) throw new Error(`unknown automation ${key}; one of ${Object.keys(settings.automations).join(', ')}`);
    const next = { ...settings.automations, [key]: { ...settings.automations[key]!, ...patch } };
    const s = await updateEmailSettings({ automations: next }, actor);
    return { key, ...s.automations[key] };
  }

  async contactsByIds(ids: string[]): Promise<Contact[]> {
    if (!ids.length) return [];
    return getDb().select().from(emailContacts).where(inArray(emailContacts.id, ids));
  }

  normalise(email: string) {
    return normaliseEmail(email);
  }
}
