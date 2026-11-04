/**
 * Campaigns (spec § Data model → email_campaigns; runbook sections 8–9).
 *
 *   draft ──schedule──▶ scheduled ──expand──▶ sending ──(queue empty)──▶ sent
 *     │  └─(Claude, marketing, audience > threshold)─▶ pending_approval ─approve─▶ scheduled
 *     └──────────── cancel (any time before sent) ──────────────────────▶ cancelled
 *   sending ⇄ paused (pause / resume)
 *
 * Standing campaign types (weekly digest, new-product alerts, back in stock,
 * automations) are pre-approved: the system makes them on a schedule and a
 * person can cancel them. Anything Claude makes for more than
 * `approval_threshold` contacts waits for a person.
 *
 * `expand` writes one `email_sends` row per audience contact, spreading
 * `not_before` evenly across the send window with ±10% jitter (deterministic
 * per contact). Kinds with per-contact content (the digest, new-product
 * alerts) supply it through a content builder; a contact whose content comes
 * back empty gets no row.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import {
  emailCampaigns,
  emailSends,
  type CampaignKind,
  type CampaignStatus,
  type EmailClass,
} from '../../../db/schema/index.js';
import type { Block } from '../templates/blocks.js';
import { buildAudience, segmentSchema } from './audience.service.js';
import type { Contact } from './contacts.service.js';
import { getEmailSettings } from './settings.service.js';

export type Campaign = typeof emailCampaigns.$inferSelect;

export class CampaignError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'bad_state' | 'invalid' | 'forbidden',
  ) {
    super(message);
  }
}

export const STANDING_KINDS: CampaignKind[] = ['weekly_digest', 'new_product', 'back_in_stock', 'automation'];

export interface CampaignInput {
  name: string;
  kind: CampaignKind;
  class?: EmailClass;
  automationKey?: string | null;
  segment?: Record<string, unknown>;
  subject?: string;
  preheader?: string | null;
  templateKey?: string;
  content?: Block[];
  scheduledAt?: Date | null;
  sendWindowMinutes?: number;
  overrideGap?: boolean;
  utmCampaign?: string | null;
}

/** What a content builder returns per contact: blocks (+ optional subject)
 *  to send, or null to skip that contact. */
export type ContactContent = { blocks: Block[]; subject?: string; data?: Record<string, unknown> } | null;
export type ContentBuilder = (campaign: Campaign, contacts: Contact[], now: Date) => Promise<Map<string, ContactContent>>;

const builders = new Map<CampaignKind, ContentBuilder>();

interface AbHooks {
  hasVariant(c: Campaign): Promise<boolean>;
  split(c: Campaign, now: Date): Promise<unknown>;
  decideDue(now: Date): Promise<number>;
}
let abHooks: AbHooks | null = null;
export function registerAbHooks(h: AbHooks): void {
  abHooks = h;
}
export function registerContentBuilder(kind: CampaignKind, b: ContentBuilder): void {
  builders.set(kind, b);
}

/** Called after a campaign's audience is built, with the contacts that were
 *  considered (e.g. the digest advances last_digest_at for every one). */
const afterExpand = new Map<CampaignKind, (campaign: Campaign, considered: Contact[], now: Date) => Promise<void>>();
export function registerAfterExpand(kind: CampaignKind, fn: (campaign: Campaign, considered: Contact[], now: Date) => Promise<void>): void {
  afterExpand.set(kind, fn);
}

/** 0..1 from a string, stable across runs. */
export function stableFraction(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0) / 0xffffffff;
}

/** `not_before` for row i of n across a window starting at `start`. */
export function spreadTime(start: Date, windowMinutes: number, i: number, n: number, seed: string): Date {
  if (windowMinutes <= 0 || n <= 1) return start;
  const slot = (windowMinutes * 60_000) / n;
  const jitter = (stableFraction(seed) * 2 - 1) * 0.1 * slot;
  return new Date(Math.max(start.getTime(), start.getTime() + i * slot + jitter));
}

export class CampaignsService {
  private db = getDb();

  async get(id: string): Promise<Campaign> {
    const [c] = await this.db.select().from(emailCampaigns).where(eq(emailCampaigns.id, id)).limit(1);
    if (!c) throw new CampaignError('campaign not found', 'not_found');
    return c;
  }

  async list(opts: { status?: CampaignStatus; limit?: number } = {}): Promise<Campaign[]> {
    return this.db
      .select()
      .from(emailCampaigns)
      .where(opts.status ? eq(emailCampaigns.status, opts.status) : undefined)
      .orderBy(sql`${emailCampaigns.createdAt} desc`)
      .limit(opts.limit ?? 100);
  }

  async create(input: CampaignInput, actor: string): Promise<Campaign> {
    if (!input.name?.trim()) throw new CampaignError('a campaign needs a name', 'invalid');
    const segment = segmentSchema.safeParse(input.segment ?? {});
    if (!segment.success) throw new CampaignError(`invalid segment: ${segment.error.message}`, 'invalid');
    const cls = input.class ?? (input.kind === 'back_in_stock' ? 'requested_service' : 'marketing');
    const [c] = await this.db
      .insert(emailCampaigns)
      .values({
        companyId: getSingletonCompanyId(),
        name: input.name.trim(),
        kind: input.kind,
        automationKey: input.automationKey ?? null,
        class: cls,
        status: 'draft',
        segment: segment.data,
        subject: input.subject ?? '',
        preheader: input.preheader ?? null,
        templateKey: input.templateKey ?? (input.kind === 'weekly_digest' ? 'weekly_digest' : input.kind === 'new_product' ? 'new_product_alert' : 'manual'),
        content: input.content ?? [],
        scheduledAt: input.scheduledAt ?? null,
        sendWindowMinutes: input.sendWindowMinutes ?? 0,
        overrideGap: input.overrideGap ?? false,
        createdBy: actor,
        utmCampaign: input.utmCampaign ?? null,
      })
      .returning();
    return c!;
  }

  /** Edit a campaign that has not started sending. A scheduled or
   *  pending-approval campaign goes back to draft. */
  async update(id: string, patch: Partial<CampaignInput>): Promise<Campaign> {
    const c = await this.get(id);
    if (!['draft', 'pending_approval', 'scheduled'].includes(c.status)) {
      throw new CampaignError(`a ${c.status} campaign cannot be edited`, 'bad_state');
    }
    if (patch.segment) {
      const seg = segmentSchema.safeParse(patch.segment);
      if (!seg.success) throw new CampaignError(`invalid segment: ${seg.error.message}`, 'invalid');
    }
    const [u] = await this.db
      .update(emailCampaigns)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.segment !== undefined ? { segment: patch.segment } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.preheader !== undefined ? { preheader: patch.preheader } : {}),
        ...(patch.templateKey !== undefined ? { templateKey: patch.templateKey } : {}),
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
        ...(patch.sendWindowMinutes !== undefined ? { sendWindowMinutes: patch.sendWindowMinutes } : {}),
        ...(patch.overrideGap !== undefined ? { overrideGap: patch.overrideGap } : {}),
        ...(patch.utmCampaign !== undefined ? { utmCampaign: patch.utmCampaign } : {}),
        status: 'draft',
        approvedBy: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(emailCampaigns.id, id))
      .returning();
    return u!;
  }

  async audienceCount(c: Campaign, now = new Date()): Promise<number> {
    return (await buildAudience(c.segment, { class: c.class, kind: c.kind, now, overrideGap: c.overrideGap })).length;
  }

  /**
   * Draft → scheduled, or → pending_approval when Claude made (or is
   * scheduling) a marketing campaign for more contacts than the threshold.
   */
  async schedule(id: string, opts: { scheduledAt?: Date; actor: string; now?: Date }): Promise<Campaign> {
    const c = await this.get(id);
    if (c.status !== 'draft') throw new CampaignError(`only a draft can be scheduled (this one is ${c.status})`, 'bad_state');
    if (c.class === 'marketing' && !c.subject.trim() && !['weekly_digest', 'new_product', 'automation'].includes(c.kind)) {
      throw new CampaignError('a marketing campaign needs a subject', 'invalid');
    }
    const now = opts.now ?? new Date();
    const settings = await getEmailSettings();
    const count = await this.audienceCount(c, now);
    const byClaude = c.createdBy === 'claude' || opts.actor === 'claude';
    const needsApproval =
      byClaude && c.class === 'marketing' && !STANDING_KINDS.includes(c.kind) && count > settings.approval_threshold;
    const [u] = await this.db
      .update(emailCampaigns)
      .set({
        status: needsApproval ? 'pending_approval' : 'scheduled',
        scheduledAt: opts.scheduledAt ?? c.scheduledAt ?? now,
        audienceCount: count,
        updatedAt: now,
      })
      .where(and(eq(emailCampaigns.id, id), eq(emailCampaigns.status, 'draft')))
      .returning();
    if (!u) throw new CampaignError('the campaign changed while scheduling', 'bad_state');
    return u;
  }

  /** A person approves a pending campaign. Never Claude: approval is the
   *  human check (spec § MCP interface). */
  async approve(id: string, actor: string): Promise<Campaign> {
    if (actor === 'claude') throw new CampaignError('approval needs a person', 'forbidden');
    const [u] = await this.db
      .update(emailCampaigns)
      .set({ status: 'scheduled', approvedBy: actor, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(emailCampaigns.id, id), eq(emailCampaigns.status, 'pending_approval')))
      .returning();
    if (!u) {
      await this.get(id);
      throw new CampaignError('only a campaign pending approval can be approved', 'bad_state');
    }
    return u;
  }

  async cancel(id: string): Promise<Campaign> {
    const c = await this.get(id);
    if (c.status === 'sent' || c.status === 'cancelled') throw new CampaignError(`a ${c.status} campaign cannot be cancelled`, 'bad_state');
    const [u] = await this.db.update(emailCampaigns).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(emailCampaigns.id, id)).returning();
    // Its A/B variant goes with it.
    await this.db
      .update(emailCampaigns)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(emailCampaigns.variantOf, id), sql`${emailCampaigns.status} not in ('sent','cancelled')`));
    await this.db
      .update(emailSends)
      .set({ status: 'dropped', dropReason: 'campaign_cancelled', updatedAt: new Date() })
      .where(and(eq(emailSends.campaignId, id), eq(emailSends.status, 'queued')));
    return u!;
  }

  async pause(id: string): Promise<Campaign> {
    return this.move(id, 'sending', 'paused');
  }

  async resume(id: string): Promise<Campaign> {
    return this.move(id, 'paused', 'sending');
  }

  private async move(id: string, from: CampaignStatus, to: CampaignStatus): Promise<Campaign> {
    const [u] = await this.db
      .update(emailCampaigns)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(emailCampaigns.id, id), eq(emailCampaigns.status, from)))
      .returning();
    if (!u) {
      const c = await this.get(id);
      throw new CampaignError(`cannot go from ${c.status} to ${to}`, 'bad_state');
    }
    return u;
  }

  /**
   * Turn a due scheduled campaign into send rows. Idempotent: rows are keyed
   * `campaign:<id>:<contact>`, and only a `scheduled` campaign is expanded.
   */
  async expand(id: string, now = new Date(), opts: { contacts?: Contact[]; variant?: string | null; status?: CampaignStatus } = {}): Promise<{ queued: number; skipped: number }> {
    const c = await this.get(id);
    if (!opts.contacts && c.status !== 'scheduled') throw new CampaignError(`only a scheduled campaign is expanded (this one is ${c.status})`, 'bad_state');
    const settings = await getEmailSettings();
    const audience = opts.contacts ?? (await buildAudience(c.segment, { class: c.class, kind: c.kind, now, overrideGap: c.overrideGap, settings }));
    const builder = builders.get(c.kind);
    const content = builder ? await builder(c, audience, now) : null;

    const rows: Array<typeof emailSends.$inferInsert> = [];
    let skipped = 0;
    const included = content ? audience.filter((a) => content.get(a.id)) : audience;
    skipped = audience.length - included.length;
    const start = c.scheduledAt && c.scheduledAt > now ? c.scheduledAt : now;
    included.forEach((contact, i) => {
      const per = content?.get(contact.id) ?? null;
      rows.push({
        companyId: getSingletonCompanyId(),
        campaignId: c.id,
        contactId: contact.id,
        class: c.class,
        kind: c.kind === 'automation' ? (c.automationKey ?? 'automation') : c.kind,
        templateKey: c.templateKey,
        data: per ? { blocks: per.blocks, ...(per.subject ? { subject: per.subject } : {}), ...(per.data ?? {}) } : {},
        variant: opts.variant ?? null,
        idempotencyKey: `campaign:${c.id}:${contact.id}`,
        status: 'queued',
        notBefore: spreadTime(start, c.sendWindowMinutes, i, included.length, `${c.id}:${contact.id}`),
        queuedAt: now,
      });
    });
    let queued = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await this.db.insert(emailSends).values(rows.slice(i, i + 500)).onConflictDoNothing({ target: emailSends.idempotencyKey }).returning({ id: emailSends.id });
      queued += res.length;
    }
    const after = afterExpand.get(c.kind);
    if (after) await after(c, audience, now);
    if (!opts.contacts) {
      await this.db
        .update(emailCampaigns)
        .set({ status: opts.status ?? 'sending', expandedAt: now, audienceCount: included.length, updatedAt: now })
        .where(eq(emailCampaigns.id, c.id));
    }
    return { queued, skipped };
  }

  /** Every minute: expand due campaigns, decide A/B tests, close finished ones. */
  async tick(now = new Date()): Promise<{ expanded: number; finished: number; decided: number }> {
    const due = await this.db
      .select({ id: emailCampaigns.id })
      .from(emailCampaigns)
      .where(and(eq(emailCampaigns.status, 'scheduled'), lte(emailCampaigns.scheduledAt, now)));
    let expanded = 0;
    for (const d of due) {
      try {
        await this.expandOrSplit(d.id, now);
        expanded++;
      } catch (err) {
        if (!(err instanceof CampaignError)) throw err;
      }
    }
    const decided = abHooks ? await abHooks.decideDue(now) : 0;
    const finished = await this.db.execute(sql`
      update email_campaigns c set status = 'sent', finished_at = ${now}, updated_at = ${now}
      where c.status = 'sending'
        and not exists (select 1 from email_sends s where s.campaign_id = c.id and s.status = 'queued')
        -- An A/B campaign is not finished until its winner has been sent.
        and (c.ab_decided_at is not null or not exists (select 1 from email_campaigns v where v.variant_of = c.id))
      returning c.id`);
    return { expanded, finished: (finished.rows as unknown[]).length, decided };
  }

  /** A campaign with a B variant is split by the A/B service (ab.service.ts
   *  registers itself); any other is expanded whole. */
  async expandOrSplit(id: string, now: Date): Promise<void> {
    const c = await this.get(id);
    if (abHooks && (await abHooks.hasVariant(c))) {
      await abHooks.split(c, now);
      return;
    }
    await this.expand(id, now);
  }

  async countSends(campaignId: string): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(emailSends).where(inArray(emailSends.campaignId, [campaignId]));
    return r?.n ?? 0;
  }
}
