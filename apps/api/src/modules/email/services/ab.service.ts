/**
 * A/B subject tests (spec § Campaign types → Manual campaign; runbook
 * section 9 step 1). A campaign's B variant is a second campaign row with
 * `variant_of` pointing at A, holding B's subject. When A goes out:
 *
 *  - audience ≥ min_audience (200): 10% get A and 10% get B (chosen by a
 *    stable hash of contact and campaign), all as rows of campaign A with
 *    `variant` A or B; `ab_test.decide_after_hours` (2) after the first send,
 *    the variant with the better unique click rate wins (a tie goes to A) and
 *    the rest of the audience gets the winner.
 *  - a smaller audience gets A only, and the B row is closed.
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { emailCampaigns, emailSends } from '../../../db/schema/index.js';
import { buildAudience } from './audience.service.js';
import { CampaignError, CampaignsService, registerAbHooks, stableFraction, type Campaign } from './campaigns.service.js';
import { getEmailSettings } from './settings.service.js';

const HOUR_MS = 3_600_000;

export class AbService {
  private campaigns = new CampaignsService();

  /** Add a B subject to a draft campaign. */
  async createVariant(campaignId: string, subjectB: string, actor: string): Promise<Campaign> {
    const a = await this.campaigns.get(campaignId);
    if (a.status !== 'draft') throw new CampaignError('add a variant while the campaign is a draft', 'bad_state');
    if (a.variantOf) throw new CampaignError('a variant cannot have a variant', 'invalid');
    const [existing] = await getDb().select().from(emailCampaigns).where(eq(emailCampaigns.variantOf, a.id));
    if (existing) {
      const [u] = await getDb().update(emailCampaigns).set({ subject: subjectB, updatedAt: new Date() }).where(eq(emailCampaigns.id, existing.id)).returning();
      return u!;
    }
    const b = await this.campaigns.create(
      {
        name: `${a.name} (B)`,
        kind: a.kind,
        class: a.class,
        segment: a.segment,
        subject: subjectB,
        preheader: a.preheader,
        templateKey: a.templateKey,
        content: a.content as never,
        sendWindowMinutes: a.sendWindowMinutes,
        utmCampaign: a.utmCampaign,
      },
      actor,
    );
    const [u] = await getDb().update(emailCampaigns).set({ variantOf: a.id }).where(eq(emailCampaigns.id, b.id)).returning();
    return u!;
  }

  async variantOf(a: Campaign): Promise<Campaign | undefined> {
    const [b] = await getDb().select().from(emailCampaigns).where(eq(emailCampaigns.variantOf, a.id));
    return b;
  }

  /** Expand an A/B campaign's test groups (or all of it, A only, when small). */
  async split(a: Campaign, now: Date): Promise<{ mode: 'ab' | 'a_only'; a: number; b: number }> {
    const b = await this.variantOf(a);
    if (!b) throw new CampaignError('no variant', 'invalid');
    const settings = await getEmailSettings();
    const audience = await buildAudience(a.segment, { class: a.class, kind: a.kind, now, overrideGap: a.overrideGap, settings });
    if (audience.length < settings.ab_test.min_audience) {
      await this.campaigns.expand(a.id, now);
      await getDb().update(emailCampaigns).set({ status: 'cancelled', updatedAt: now }).where(eq(emailCampaigns.id, b.id));
      await getDb().update(emailCampaigns).set({ abWinner: 'A', abDecidedAt: now }).where(eq(emailCampaigns.id, a.id));
      return { mode: 'a_only', a: audience.length, b: 0 };
    }
    const ordered = [...audience].sort((x, y) => stableFraction(`${a.id}:${x.id}`) - stableFraction(`${a.id}:${y.id}`));
    const each = Math.floor((audience.length * settings.ab_test.share) / 2);
    const groupA = ordered.slice(0, each);
    const groupB = ordered.slice(each, each * 2);
    const ra = await this.campaigns.expand(a.id, now, { contacts: groupA, variant: 'A' });
    const rb = await this.campaigns.expand(a.id, now, { contacts: groupB, variant: 'B' });
    // B's rows carry B's subject.
    await getDb()
      .update(emailSends)
      .set({ data: sql`${emailSends.data} || ${JSON.stringify({ subject: b.subject })}::jsonb` })
      .where(and(eq(emailSends.campaignId, a.id), eq(emailSends.variant, 'B')));
    await getDb().update(emailCampaigns).set({ status: 'sending', expandedAt: now, audienceCount: audience.length, updatedAt: now }).where(eq(emailCampaigns.id, a.id));
    await getDb().update(emailCampaigns).set({ status: 'sending', updatedAt: now }).where(eq(emailCampaigns.id, b.id));
    return { mode: 'ab', a: ra.queued, b: rb.queued };
  }

  /** Unique click rate per variant among sent rows. */
  async rates(campaignId: string): Promise<Record<'A' | 'B', { sent: number; clicked: number; rate: number }>> {
    const rows = await getDb()
      .select({
        variant: emailSends.variant,
        sent: sql<number>`count(*) filter (where ${emailSends.sentAt} is not null)::int`,
        clicked: sql<number>`count(*) filter (where ${emailSends.firstClickAt} is not null)::int`,
      })
      .from(emailSends)
      .where(and(eq(emailSends.campaignId, campaignId), isNotNull(emailSends.variant)))
      .groupBy(emailSends.variant);
    const out = { A: { sent: 0, clicked: 0, rate: 0 }, B: { sent: 0, clicked: 0, rate: 0 } };
    for (const r of rows) {
      if (r.variant === 'A' || r.variant === 'B') out[r.variant] = { sent: r.sent, clicked: r.clicked, rate: r.sent ? r.clicked / r.sent : 0 };
    }
    return out;
  }

  /** Pick the winner once the test has run long enough, and send the rest. */
  async decideDue(now: Date): Promise<number> {
    const settings = await getEmailSettings();
    const pending = await getDb()
      .select()
      .from(emailCampaigns)
      .where(and(eq(emailCampaigns.status, 'sending'), isNull(emailCampaigns.abDecidedAt), isNull(emailCampaigns.variantOf)));
    let decided = 0;
    for (const a of pending) {
      const b = await this.variantOf(a);
      if (!b) continue;
      const [first] = await getDb()
        .select({ at: sql<Date | null>`min(${emailSends.sentAt})` })
        .from(emailSends)
        .where(eq(emailSends.campaignId, a.id));
      if (!first?.at || new Date(first.at).getTime() + settings.ab_test.decide_after_hours * HOUR_MS > now.getTime()) continue;
      const r = await this.rates(a.id);
      const winner: 'A' | 'B' = r.B.rate > r.A.rate ? 'B' : 'A';
      const claimed = await getDb()
        .update(emailCampaigns)
        .set({ abWinner: winner, abDecidedAt: now, updatedAt: now })
        .where(and(eq(emailCampaigns.id, a.id), isNull(emailCampaigns.abDecidedAt)))
        .returning({ id: emailCampaigns.id });
      if (claimed.length === 0) continue;
      const audience = await buildAudience(a.segment, { class: a.class, kind: a.kind, now, overrideGap: a.overrideGap, settings });
      await this.campaigns.expand(a.id, now, { contacts: audience, variant: winner });
      if (winner === 'B') {
        await getDb()
          .update(emailSends)
          .set({ data: sql`${emailSends.data} || ${JSON.stringify({ subject: b.subject })}::jsonb` })
          .where(and(eq(emailSends.campaignId, a.id), eq(emailSends.variant, 'B'), eq(emailSends.status, 'queued')));
      }
      await getDb().update(emailCampaigns).set({ status: 'sent', finishedAt: now, updatedAt: now }).where(eq(emailCampaigns.id, b.id));
      decided++;
    }
    return decided;
  }
}

const ab = new AbService();
registerAbHooks({
  hasVariant: async (c) => !c.variantOf && Boolean(await ab.variantOf(c)),
  split: (c, now) => ab.split(c, now),
  decideDue: (now) => ab.decideDue(now),
});
