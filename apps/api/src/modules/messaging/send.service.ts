/**
 * send-message (SPEC §12.1 rule 5, §12.3). The LAST gate before SendGrid — no
 * upstream code, human, or LLM can breach it. AT SEND TIME it re-checks
 * suppression, marketing consent, expiry, and the frequency cap; the draft id is
 * the idempotency key so a retry can never double-send.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { messageDrafts, storefrontUsers, consentRecords } from '../../db/schema/index.js';
import { getEnv } from '../../config/env.js';
import { emitDomainEvent } from '../../shared/events/emit.js';
import { getSendGrid } from '../../integrations/sendgrid/sendgrid.js';
import { SuppressionService } from './suppression.service.js';
import { unsubscribeUrl } from './unsubscribe.js';

export type SendOutcome =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'not_found' | 'not_approved' | 'already_sent' | string };

export class SendService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private suppression = new SuppressionService();

  private async currentMarketingConsent(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ granted: consentRecords.granted })
      .from(consentRecords)
      .where(and(eq(consentRecords.userId, userId), eq(consentRecords.consentType, 'general_marketing')))
      .orderBy(sql`${consentRecords.createdAt} DESC`)
      .limit(1);
    return row?.granted ?? false;
  }

  private async frequencyCapBreached(userId: string, nowMs: number): Promise<boolean> {
    const env = getEnv();
    const since = new Date(nowMs - env.MARKETING_FREQ_CAP_DAYS * 86_400_000);
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(messageDrafts)
      .where(
        and(
          eq(messageDrafts.userId, userId),
          eq(messageDrafts.category, 'marketing'),
          eq(messageDrafts.status, 'sent'),
          gte(messageDrafts.resolvedAt, since),
        ),
      );
    return Number(row?.n ?? 0) >= env.MARKETING_FREQ_CAP_COUNT;
  }

  private async park(draftId: string, reason: string): Promise<SendOutcome> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messageDrafts)
        .set({
          status: 'failed',
          editorNotes: `parked:${reason}`,
          rejectReason: reason === 'expired' ? 'expired' : 'should_not_send',
          resolvedAt: new Date(),
        })
        .where(eq(messageDrafts.id, draftId));
      await emitDomainEvent(tx, {
        eventType: 'message.failed',
        aggregateType: 'draft',
        aggregateId: draftId,
        payload: { draftId, reason },
      });
    });
    return { sent: false, reason };
  }

  async send(draftId: string, nowMs = Date.now()): Promise<SendOutcome> {
    const [draft] = await this.db.select().from(messageDrafts).where(eq(messageDrafts.id, draftId)).limit(1);
    if (!draft) return { sent: false, reason: 'not_found' };
    if (draft.status === 'sent') return { sent: true, messageId: draft.sendgridMessageId ?? 'already' };
    if (draft.status !== 'approved' && draft.status !== 'auto_approved') {
      return { sent: false, reason: 'not_approved' };
    }

    const [user] = await this.db
      .select({ email: storefrontUsers.email })
      .from(storefrontUsers)
      .where(eq(storefrontUsers.id, draft.userId))
      .limit(1);
    if (!user?.email) return this.park(draftId, 'no_recipient');

    // Expiry (§17.7).
    if (draft.expiresAt && draft.expiresAt.getTime() < nowMs) return this.park(draftId, 'expired');

    // Suppression — even if it was added AFTER approval.
    if (await this.suppression.isSuppressed(user.email)) return this.park(draftId, 'suppressed');

    if (draft.category === 'marketing') {
      if (!(await this.currentMarketingConsent(draft.userId))) return this.park(draftId, 'no_consent');
      if (await this.frequencyCapBreached(draft.userId, nowMs)) return this.park(draftId, 'frequency_cap');
    }

    const result = await getSendGrid().send({
      to: user.email,
      category: draft.category,
      subject: draft.subject,
      html: draft.body,
      idempotencyKey: draftId, // wrapper dedupes
      unsubscribeUrl: draft.category === 'marketing' ? unsubscribeUrl(draft.userId) : undefined,
    });

    // Conditional update is the idempotency guard: only the first caller flips
    // the draft to sent and emits message.sent.
    const updated = await this.db
      .update(messageDrafts)
      .set({ status: 'sent', sendgridMessageId: result.messageId, resolvedAt: new Date() })
      .where(and(eq(messageDrafts.id, draftId), sql`${messageDrafts.status} <> 'sent'`))
      .returning({ id: messageDrafts.id });

    if (updated.length > 0) {
      await this.db.transaction(async (tx) => {
        await emitDomainEvent(tx, {
          eventType: 'message.sent',
          aggregateType: 'draft',
          aggregateId: draftId,
          payload: { draftId, sendgridMessageId: result.messageId },
        });
      });
    }
    return { sent: true, messageId: result.messageId };
  }
}
