/**
 * Suppression + consent-revocation on inbound SendGrid events / unsubscribe
 * (SPEC §4.6, §12.4). Postgres is the compliance record; the suppression_list
 * is the mutable send-time cache. An unsubscribe also writes a consent
 * revocation (append-only).
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { suppressionList, storefrontUsers, consentRecords } from '../../db/schema/index.js';
import { emitDomainEvent } from '../../shared/events/emit.js';

export type SuppressionReason = 'bounce' | 'complaint' | 'unsubscribe' | 'manual';

export class SuppressionService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  async isSuppressed(email: string): Promise<boolean> {
    const [row] = await this.db
      .select({ email: suppressionList.email })
      .from(suppressionList)
      .where(eq(suppressionList.email, email))
      .limit(1);
    return !!row;
  }

  /** Upsert the suppression cache + emit suppression.updated. When the reason is
   *  an unsubscribe/complaint, also revoke the user's general_marketing consent. */
  async suppress(email: string, reason: SuppressionReason): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(suppressionList)
        .values({ email, companyId: this.companyId, reason })
        .onConflictDoUpdate({
          target: suppressionList.email,
          set: { reason, updatedAt: new Date() },
        });
      await emitDomainEvent(tx, {
        eventType: 'suppression.updated',
        aggregateType: 'user',
        aggregateId: undefined,
        payload: { email, reason },
      });

      if (reason === 'unsubscribe' || reason === 'complaint') {
        const [user] = await tx
          .select({ id: storefrontUsers.id })
          .from(storefrontUsers)
          .where(eq(storefrontUsers.email, email))
          .limit(1);
        if (user) {
          await tx.insert(consentRecords).values({
            companyId: this.companyId,
            userId: user.id,
            consentType: 'general_marketing',
            granted: false,
            source: `suppression:${reason}`,
          });
          await emitDomainEvent(tx, {
            eventType: 'consent.revoked',
            aggregateType: 'consent',
            aggregateId: user.id,
            payload: { userId: user.id, consentType: 'general_marketing', source: reason },
          });
        }
      }
    });
  }

  /** Cancel queued/pending drafts for a user whose consent was revoked /
   *  suppressed (§12.4). */
  async cancelPendingDraftsForEmail(email: string): Promise<number> {
    const res = await this.db.execute(sql`
      UPDATE message_drafts d
      SET status = 'failed', reject_reason = 'should_not_send', resolved_at = now()
      FROM storefront_users u
      WHERE d.user_id = u.id
        AND u.email = ${email}
        AND d.status IN ('pending','approved','auto_approved')
        AND d.category = 'marketing'
    `);
    return (res as { rowCount?: number }).rowCount ?? 0;
  }
}
