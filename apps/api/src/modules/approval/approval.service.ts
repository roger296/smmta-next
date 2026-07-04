/**
 * Approval queue (SPEC §17). The owner's inbox: one priority-ordered list of
 * drafts + escalations, a facts panel from each draft's trigger event, the three
 * actions (approve / edit-then-approve / reject), batch group review with random
 * spot-checks, per-type auto-send graduation, and the staleness sweep.
 *
 * Approving a draft emits draft.approved → the dispatcher enqueues send-message
 * (Prompt 9), so the queue is the trust instrument that actually sends mail.
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { messageDrafts, escalations, domainEvents, agentConfig } from '../../db/schema/index.js';
import { emitDomainEvent } from '../../shared/events/emit.js';

export type RejectReason = 'wrong_facts' | 'wrong_tone' | 'should_not_send' | 'other';

export class IllegalTransitionError extends Error {}

/** Priority rank for the single inbox (§17.3): lower = more urgent. */
function draftRank(groupKey: string | null, category: string): number {
  const templateKey = groupKey?.split(':')[0] ?? '';
  if (templateKey === 'eta_slip') return 0; // ETA-change notices to paid customers
  if (templateKey === 'back_in_stock') return 2; // fanouts
  if (category === 'marketing') return 3; // nightly marketing — waits for morning
  return 1; // other transactional
}

/** Deterministic-when-seeded spot-check selection (§17.4). */
export function selectSpotChecks<T>(members: T[], k: number, seed: number): T[] {
  const arr = [...members];
  let s = seed >>> 0 || 1;
  // LCG shuffle.
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, Math.min(k, arr.length));
}

export class ApprovalQueueService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  /** The single priority-ordered inbox: pending drafts + open escalations. */
  async listQueue(nowMs = Date.now()) {
    const drafts = await this.db
      .select()
      .from(messageDrafts)
      .where(and(eq(messageDrafts.companyId, this.companyId), eq(messageDrafts.status, 'pending')));
    const openEscalations = await this.db
      .select()
      .from(escalations)
      .where(and(eq(escalations.companyId, this.companyId), eq(escalations.status, 'open')));

    const items = [
      ...drafts.map((d) => ({
        type: 'draft' as const,
        id: d.id,
        rank: draftRank(d.groupKey, d.category),
        subject: d.subject,
        groupKey: d.groupKey,
        category: d.category,
        expiresAt: d.expiresAt?.toISOString() ?? null,
        expiresInMs: d.expiresAt ? d.expiresAt.getTime() - nowMs : null,
        createdAt: d.createdAt.toISOString(),
      })),
      ...openEscalations.map((e) => ({
        type: 'escalation' as const,
        id: e.id,
        rank: 1,
        subject: `Escalation: ${e.reason}`,
        groupKey: null,
        category: 'transactional',
        expiresAt: null,
        expiresInMs: null,
        createdAt: e.createdAt.toISOString(),
      })),
    ];
    items.sort((a, b) => a.rank - b.rank || a.createdAt.localeCompare(b.createdAt));
    return items;
  }

  /** Draft + its trigger event payload (the facts panel, §17.2). */
  async getDraftDetail(draftId: string) {
    const [draft] = await this.db.select().from(messageDrafts).where(eq(messageDrafts.id, draftId)).limit(1);
    if (!draft) return undefined;
    let facts: unknown = null;
    if (draft.triggerEventId) {
      const [event] = await this.db
        .select({ eventType: domainEvents.eventType, payload: domainEvents.payload })
        .from(domainEvents)
        .where(eq(domainEvents.id, draft.triggerEventId))
        .limit(1);
      facts = event ?? null;
    }
    return { draft, facts };
  }

  private async requirePending(draftId: string) {
    const [draft] = await this.db.select().from(messageDrafts).where(eq(messageDrafts.id, draftId)).limit(1);
    if (!draft) throw new IllegalTransitionError('draft not found');
    if (draft.status !== 'pending') {
      throw new IllegalTransitionError(`cannot act on a ${draft.status} draft`);
    }
    return draft;
  }

  async approve(draftId: string): Promise<void> {
    await this.requirePending(draftId);
    await this.transitionToApproved(draftId);
  }

  async editThenApprove(draftId: string, subject: string, body: string): Promise<void> {
    const draft = await this.requirePending(draftId);
    await this.db
      .update(messageDrafts)
      .set({ bodyOriginal: draft.body, subject, body })
      .where(eq(messageDrafts.id, draftId));
    await this.transitionToApproved(draftId);
  }

  private async transitionToApproved(draftId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messageDrafts)
        .set({ status: 'approved', resolvedAt: new Date() })
        .where(eq(messageDrafts.id, draftId));
      await emitDomainEvent(tx, {
        eventType: 'draft.approved',
        aggregateType: 'draft',
        aggregateId: draftId,
        payload: { draftId },
      });
    });
  }

  async reject(draftId: string, reason: RejectReason): Promise<void> {
    await this.requirePending(draftId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(messageDrafts)
        .set({ status: 'rejected', rejectReason: reason, resolvedAt: new Date() })
        .where(eq(messageDrafts.id, draftId));
      await emitDomainEvent(tx, {
        eventType: 'draft.rejected',
        aggregateType: 'draft',
        aggregateId: draftId,
        payload: { draftId, reason },
      });
    });
  }

  /** Group review (§17.4): one rendered instance + K random spot-checks. */
  async getGroup(groupKey: string, k = 3, seed = Date.now()) {
    const members = await this.db
      .select()
      .from(messageDrafts)
      .where(
        and(
          eq(messageDrafts.companyId, this.companyId),
          eq(messageDrafts.groupKey, groupKey),
          eq(messageDrafts.status, 'pending'),
        ),
      );
    return {
      groupKey,
      total: members.length,
      rendered: members[0] ?? null,
      spotChecks: selectSpotChecks(members, k, seed),
    };
  }

  async approveGroup(groupKey: string): Promise<number> {
    const members = await this.db
      .select({ id: messageDrafts.id })
      .from(messageDrafts)
      .where(
        and(
          eq(messageDrafts.companyId, this.companyId),
          eq(messageDrafts.groupKey, groupKey),
          eq(messageDrafts.status, 'pending'),
        ),
      );
    for (const m of members) await this.transitionToApproved(m.id);
    return members.length;
  }

  async resolveEscalation(id: string): Promise<void> {
    await this.db
      .update(escalations)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(escalations.id, id));
  }

  /** Rolling approved-unedited rate over the last N resolved drafts of a type
   *  (§17.6). templateKey = the group_key prefix. */
  async graduationStats(templateKey: string, sampleSize = 50) {
    const recent = await this.db
      .select({ status: messageDrafts.status, bodyOriginal: messageDrafts.bodyOriginal })
      .from(messageDrafts)
      .where(
        and(
          eq(messageDrafts.companyId, this.companyId),
          sql`${messageDrafts.groupKey} LIKE ${templateKey + ':%'}`,
          inArray(messageDrafts.status, ['approved', 'auto_approved', 'rejected', 'sent']),
        ),
      )
      .orderBy(desc(messageDrafts.resolvedAt))
      .limit(sampleSize);
    const n = recent.length;
    const approvedUnedited = recent.filter(
      (r) => (r.status === 'approved' || r.status === 'auto_approved' || r.status === 'sent') && r.bodyOriginal == null,
    ).length;
    return { sampleSize: n, approvedUneditedRate: n > 0 ? approvedUnedited / n : 0 };
  }

  async setAutoSend(templateKey: string, enabled: boolean): Promise<void> {
    await this.db
      .insert(agentConfig)
      .values({ eventType: templateKey, companyId: this.companyId, autoSendEnabled: enabled })
      .onConflictDoUpdate({ target: agentConfig.eventType, set: { autoSendEnabled: enabled, updatedAt: new Date() } });
  }

  /** Staleness sweep (§17.7): expire overdue pending/approved drafts. */
  async expiredDraftSweep(nowMs = Date.now()): Promise<number> {
    const rows = await this.db
      .update(messageDrafts)
      .set({ status: 'failed', rejectReason: 'expired', editorNotes: 'parked:expired', resolvedAt: new Date() })
      .where(
        and(
          eq(messageDrafts.companyId, this.companyId),
          inArray(messageDrafts.status, ['pending', 'approved', 'auto_approved']),
          lt(messageDrafts.expiresAt, new Date(nowMs)),
        ),
      )
      .returning({ id: messageDrafts.id });
    return rows.length;
  }
}
