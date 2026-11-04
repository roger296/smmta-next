/**
 * Audiences (runbook section 8 step 1). A segment is a small JSON definition;
 * `buildAudience` turns it into contact ids that would pass the gate for the
 * given class and kind, and `previewSegment` gives the count and ten
 * samples. Structural filters run in SQL; interests (which decay) and the
 * gate run in code over the candidates, in one pass with one query for the
 * engagement history.
 */
import { and, eq, gte, inArray, lt, notInArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { emailContacts, emailSends, type EmailClass } from '../../../db/schema/index.js';
import { canSend } from '../lib/gate.js';
import { isInterested, type InterestPolicy } from '../lib/interests.js';
import { maskEmail } from '../lib/normalise.js';
import type { EmailSettings } from '../lib/settings-defaults.js';
import type { Contact } from './contacts.service.js';
import { getEmailSettings } from './settings.service.js';

export const segmentSchema = z
  .object({
    status: z.enum(['all', 'transactional_only', 'never']).optional(),
    interests_any: z.array(z.string()).optional(),
    interests_all: z.array(z.string()).optional(),
    is_trade: z.boolean().optional(),
    last_order_within_days: z.number().int().positive().optional(),
    last_order_older_than_days: z.number().int().positive().optional(),
    /** A click or an order within N days. */
    engaged_within_days: z.number().int().positive().optional(),
    source: z.string().optional(),
    exclude_campaign_ids: z.array(z.string().uuid()).optional(),
    contact_ids: z.array(z.string().uuid()).optional(),
  })
  .strict();
export type Segment = z.infer<typeof segmentSchema>;

const DAY_MS = 86_400_000;

export interface AudienceOptions {
  class: EmailClass;
  kind: string;
  now?: Date;
  overrideGap?: boolean;
  settings?: EmailSettings;
}

export function policyFrom(s: EmailSettings): InterestPolicy {
  return {
    halfLifeDays: s.interest_decay.half_life_days,
    orderPoints: s.interest_decay.order_points,
    clickPoints: s.interest_decay.click_points,
    threshold: s.interest_decay.interested_threshold,
  };
}

function where(segment: Segment, now: Date): SQL[] {
  const w: SQL[] = [];
  if (segment.status) w.push(eq(emailContacts.marketingStatus, segment.status));
  if (segment.is_trade !== undefined) w.push(eq(emailContacts.isTrade, segment.is_trade));
  if (segment.last_order_within_days) w.push(gte(emailContacts.lastOrderAt, new Date(now.getTime() - segment.last_order_within_days * DAY_MS)));
  if (segment.last_order_older_than_days) w.push(lt(emailContacts.lastOrderAt, new Date(now.getTime() - segment.last_order_older_than_days * DAY_MS)));
  if (segment.engaged_within_days) {
    const since = new Date(now.getTime() - segment.engaged_within_days * DAY_MS);
    w.push(sql`(${emailContacts.lastClickAt} >= ${since} or ${emailContacts.lastOrderAt} >= ${since})`);
  }
  if (segment.source) w.push(eq(emailContacts.consentSource, segment.source));
  if (segment.contact_ids) w.push(segment.contact_ids.length ? inArray(emailContacts.id, segment.contact_ids) : sql`false`);
  if (segment.exclude_campaign_ids?.length) {
    w.push(
      notInArray(
        emailContacts.id,
        getDb()
          .select({ id: emailSends.contactId })
          .from(emailSends)
          .where(inArray(emailSends.campaignId, segment.exclude_campaign_ids)),
      ),
    );
  }
  return w;
}

/** The contacts matching the segment before the gate (interests applied). */
export async function segmentContacts(segmentIn: unknown, now = new Date(), settingsIn?: EmailSettings): Promise<Contact[]> {
  const segment = segmentSchema.parse(segmentIn ?? {});
  const settings = settingsIn ?? (await getEmailSettings());
  const policy = policyFrom(settings);
  const conds = where(segment, now);
  const rows = await getDb()
    .select()
    .from(emailContacts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(emailContacts.createdAt);
  return rows.filter((c) => {
    if (segment.interests_any?.length && !segment.interests_any.some((k) => isInterested(c.interests, k, now, policy))) return false;
    if (segment.interests_all?.length && !segment.interests_all.every((k) => isInterested(c.interests, k, now, policy))) return false;
    return true;
  });
}

/** Unengaged-marketing streaks for many contacts in one query. */
export async function unengagedStreaks(contactIds: string[], limit: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (contactIds.length === 0) return out;
  for (let i = 0; i < contactIds.length; i += 5000) {
    const chunk = contactIds.slice(i, i + 5000);
    const res = await getDb().execute(sql`
      select s.contact_id, s.first_click_at, s.sent_at, c.last_order_at
      from (
        select contact_id, first_click_at, sent_at,
               row_number() over (partition by contact_id order by sent_at desc) as rn
        from email_sends
        where class = 'marketing' and sent_at is not null and contact_id in ${chunk}
      ) s join email_contacts c on c.id = s.contact_id
      where s.rn <= ${limit}
      order by s.contact_id, s.sent_at desc`);
    let current = '';
    let stopped = false;
    for (const r of res.rows as Array<{ contact_id: string; first_click_at: Date | null; sent_at: Date; last_order_at: Date | null }>) {
      if (r.contact_id !== current) {
        current = r.contact_id;
        stopped = false;
        out.set(current, 0);
      }
      if (stopped) continue;
      const orderedAfter = r.last_order_at && new Date(r.last_order_at) > new Date(r.sent_at);
      if (r.first_click_at || orderedAfter) stopped = true;
      else out.set(current, (out.get(current) ?? 0) + 1);
    }
  }
  return out;
}

/** Contact ids in the segment that the gate would let this email reach. */
export async function buildAudience(segmentIn: unknown, opts: AudienceOptions): Promise<Contact[]> {
  const now = opts.now ?? new Date();
  const settings = opts.settings ?? (await getEmailSettings());
  const candidates = await segmentContacts(segmentIn, now, settings);
  const streaks = opts.class === 'marketing' ? await unengagedStreaks(candidates.map((c) => c.id), settings.unengaged_limit) : new Map();
  return candidates.filter(
    (c) =>
      canSend(c, {
        class: opts.class,
        kind: opts.kind,
        now,
        settings,
        overrideGap: opts.overrideGap,
        unengagedStreak: streaks.get(c.id) ?? 0,
      }).ok,
  );
}

export async function previewSegment(segmentIn: unknown, opts: AudienceOptions): Promise<{ count: number; samples: Array<{ id: string; email: string; marketingStatus: string; isTrade: boolean }> }> {
  const audience = await buildAudience(segmentIn, opts);
  return {
    count: audience.length,
    samples: audience.slice(0, 10).map((c) => ({ id: c.id, email: maskEmail(c.email), marketingStatus: c.marketingStatus, isTrade: c.isTrade })),
  };
}
