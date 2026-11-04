/**
 * Reports (runbook section 9 step 2). Every number comes from one SQL
 * aggregate — no per-row loops — so a campaign of 50,000 sends reports in
 * well under half a second (see reports.service.test.ts).
 *
 * Revenue leads: a campaign is judged on attributed orders and revenue per
 * 1,000 sent, not opens (Apple Mail opens everything).
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { customerOrders, emailSends } from '../../../db/schema/index.js';
import { maskEmail } from '../lib/normalise.js';

export interface SendCounts {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  deferred: number;
  bounced: number;
  dropped: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  complained: number;
}

export interface CampaignReport extends SendCounts {
  campaignId: string;
  droppedByReason: Record<string, number>;
  /** Clicks per link (tracking parameters stripped), most first. */
  links: Array<{ url: string; clicks: number }>;
  /** People who unsubscribed within 7 days of being sent this campaign. */
  unsubscribesAfter: number;
  orders: number;
  revenueExVat: number;
  revenueIncVat: number;
  revenuePer1000: number;
  ab: Array<{ variant: string; sent: number; clicked: number; clickRate: number }>;
}

const countsSql = sql`
  count(*)::int as total,
  count(*) filter (where status = 'queued')::int as queued,
  count(*) filter (where sent_at is not null)::int as sent,
  count(*) filter (where delivered_at is not null)::int as delivered,
  count(*) filter (where status = 'deferred')::int as deferred,
  count(*) filter (where status = 'bounced')::int as bounced,
  count(*) filter (where status = 'dropped')::int as dropped,
  count(*) filter (where first_open_at is not null)::int as opened,
  count(*) filter (where first_click_at is not null)::int as clicked,
  count(*) filter (where status = 'unsubscribed')::int as unsubscribed,
  count(*) filter (where status = 'complained')::int as complained`;

function num(v: unknown): number {
  return Number(v ?? 0) || 0;
}

export class ReportsService {
  private db = getDb();

  async campaignReport(campaignId: string): Promise<CampaignReport> {
    const db = this.db;
    const [counts] = (await db.execute(sql`select ${countsSql} from email_sends where campaign_id = ${campaignId}`)).rows as unknown as SendCounts[];
    const dropped = (
      await db.execute(sql`select coalesce(drop_reason, 'unknown') as reason, count(*)::int as n from email_sends where campaign_id = ${campaignId} and status = 'dropped' group by 1`)
    ).rows as Array<{ reason: string; n: number }>;
    const links = (
      await db.execute(sql`
        select regexp_replace(e.payload->>'url', '[?&](eid|utm_[a-z]+|ik)=[^&]*', '', 'g') as url, count(*)::int as clicks
        from email_events e join email_sends s on s.id = e.send_id
        where s.campaign_id = ${campaignId} and e.event = 'click' and e.payload ? 'url'
        group by 1 order by 2 desc limit 50`)
    ).rows as Array<{ url: string; clicks: number }>;
    const [unsub] = (
      await db.execute(sql`
        select count(distinct e.contact_id)::int as n
        from email_consent_events e
        join email_sends s on s.contact_id = e.contact_id and s.campaign_id = ${campaignId} and s.sent_at is not null
        where e.to_status = 'transactional_only' and e.from_status = 'all'
          and e.created_at between s.sent_at and s.sent_at + interval '7 days'`)
    ).rows as Array<{ n: number }>;
    const [orders] = await db
      .select({
        n: sql<number>`count(*)::int`,
        ex: sql<string>`coalesce(sum(${customerOrders.orderTotal}), 0)`,
        inc: sql<string>`coalesce(sum(${customerOrders.grandTotal}), 0)`,
      })
      .from(customerOrders)
      .where(eq(customerOrders.emailCampaignId, campaignId));
    const ab = (
      await db.execute(sql`
        select variant, count(*) filter (where sent_at is not null)::int as sent, count(*) filter (where first_click_at is not null)::int as clicked
        from email_sends where campaign_id = ${campaignId} and variant is not null group by variant order by variant`)
    ).rows as Array<{ variant: string; sent: number; clicked: number }>;

    const c = Object.fromEntries(Object.entries(counts ?? {}).map(([k, v]) => [k, num(v)])) as unknown as SendCounts;
    const revenueExVat = num(orders?.ex);
    return {
      campaignId,
      ...c,
      droppedByReason: Object.fromEntries(dropped.map((d) => [d.reason, num(d.n)])),
      links: links.map((l) => ({ url: l.url, clicks: num(l.clicks) })),
      unsubscribesAfter: num(unsub?.n),
      orders: num(orders?.n),
      revenueExVat,
      revenueIncVat: num(orders?.inc),
      revenuePer1000: c.sent ? Math.round((revenueExVat / c.sent) * 1000 * 100) / 100 : 0,
      ab: ab.map((a) => ({ variant: a.variant, sent: num(a.sent), clicked: num(a.clicked), clickRate: num(a.sent) ? num(a.clicked) / num(a.sent) : 0 })),
    };
  }

  /** One automation (or any send kind) over the last `days`. */
  async automationReport(kind: string, days: number, now = new Date()) {
    const since = new Date(now.getTime() - days * 86_400_000);
    const [counts] = (await this.db.execute(sql`select ${countsSql} from email_sends where kind = ${kind} and queued_at >= ${since}`)).rows as unknown as SendCounts[];
    const [orders] = (
      await this.db.execute(sql`
        select count(*)::int as n, coalesce(sum(o.order_total), 0) as ex
        from customer_orders o join email_sends s on s.id = o.email_send_id
        where s.kind = ${kind} and s.queued_at >= ${since}`)
    ).rows as Array<{ n: number; ex: string }>;
    const c = Object.fromEntries(Object.entries(counts ?? {}).map(([k, v]) => [k, num(v)])) as unknown as SendCounts;
    return { kind, days, ...c, orders: num(orders?.n), revenueExVat: num(orders?.ex), revenuePer1000: c.sent ? Math.round((num(orders?.ex) / c.sent) * 100_000) / 100 : 0 };
  }

  /** Per day and class: sends, bounces, complaints and their rates. */
  async deliverabilityReport(days: number, now = new Date()) {
    const since = new Date(now.getTime() - days * 86_400_000);
    const rows = await this.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${emailSends.sentAt} at time zone 'Europe/London'), 'YYYY-MM-DD')`,
        class: emailSends.class,
        sent: sql<number>`count(*)::int`,
        bounced: sql<number>`count(*) filter (where ${emailSends.status} = 'bounced')::int`,
        complained: sql<number>`count(*) filter (where ${emailSends.status} = 'complained')::int`,
      })
      .from(emailSends)
      .where(and(gte(emailSends.sentAt, since)))
      .groupBy(sql`1`, emailSends.class)
      .orderBy(sql`1`);
    return rows.map((r) => ({ ...r, bounceRate: r.sent ? r.bounced / r.sent : 0, complaintRate: r.sent ? r.complained / r.sent : 0 }));
  }

  /**
   * A contact's history, newest first: sends (with their events), consent
   * changes and orders, interleaved and paged.
   */
  async contactTimeline(contactId: string, opts: { limit?: number; before?: Date } = {}) {
    const limit = Math.min(opts.limit ?? 50, 200);
    const before = opts.before ?? new Date('9999-01-01');
    const rows = (
      await this.db.execute(sql`
        select * from (
          select 'send' as type, s.id, coalesce(s.sent_at, s.queued_at) as at,
                 jsonb_build_object('kind', s.kind, 'class', s.class, 'status', s.status, 'subject', s.subject,
                   'dropReason', s.drop_reason, 'campaignId', s.campaign_id,
                   'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'at', e.occurred_at, 'url', e.payload->>'url') order by e.occurred_at)
                                       from email_events e where e.send_id = s.id), '[]'::jsonb)) as detail
          from email_sends s where s.contact_id = ${contactId}
          union all
          select 'consent', e.id, e.created_at,
                 jsonb_build_object('from', e.from_status, 'to', e.to_status, 'source', e.source, 'actor', e.actor, 'reason', e.reason)
          from email_consent_events e where e.contact_id = ${contactId}
          union all
          select 'order', o.id, o.created_at,
                 jsonb_build_object('orderNumber', o.order_number, 'total', o.grand_total, 'status', o.status, 'emailSendId', o.email_send_id)
          from customer_orders o join customers c on c.id = o.customer_id
          where c.contact_id = ${contactId} and o.deleted_at is null
        ) t
        where t.at < ${before}
        order by t.at desc
        limit ${limit}`)
    ).rows as Array<{ type: string; id: string; at: string; detail: Record<string, unknown> }>;
    return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
  }

  /** For lists: recent sends of a campaign, addresses masked. */
  async campaignSends(campaignId: string, limit = 100) {
    const rows = (
      await this.db.execute(sql`
        select s.id, c.email, s.status, s.variant, s.sent_at, s.drop_reason
        from email_sends s join email_contacts c on c.id = s.contact_id
        where s.campaign_id = ${campaignId} order by s.created_at desc limit ${limit}`)
    ).rows as Array<{ id: string; email: string; status: string; variant: string | null; sent_at: string | null; drop_reason: string | null }>;
    return rows.map((r) => ({ ...r, email: maskEmail(r.email) }));
  }
}
