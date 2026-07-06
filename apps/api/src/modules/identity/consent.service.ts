/**
 * Consent service (SPEC §13.2, F9, §7 PECR).
 *
 * consent_records is APPEND-ONLY (DB trigger enforces it). A grant or a
 * revocation is always a NEW row; "current consent" is the latest row per
 * (user, type). Each write emits consent.granted / consent.revoked in the same
 * transaction as the insert (outbox guarantee).
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { consentRecords } from '../../db/schema/index.js';
import { emitDomainEvent } from '../../shared/events/emit.js';

export type ConsentType = 'flag_updates' | 'general_marketing';

export class ConsentService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  async grant(userId: string, consentType: ConsentType, source: string) {
    return this.write(userId, consentType, true, source);
  }

  async revoke(userId: string, consentType: ConsentType, source: string) {
    return this.write(userId, consentType, false, source);
  }

  private async write(userId: string, consentType: ConsentType, granted: boolean, source: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(consentRecords)
        .values({ companyId: this.companyId, userId, consentType, granted, source })
        .returning();
      await emitDomainEvent(tx, {
        eventType: granted ? 'consent.granted' : 'consent.revoked',
        aggregateType: 'consent',
        aggregateId: userId,
        payload: { userId, consentType, source },
      });
      return row!;
    });
  }

  /** Latest consent state for (user, type). Defaults to false (no consent). */
  async currentConsent(userId: string, consentType: ConsentType): Promise<boolean> {
    const [row] = await this.db
      .select({ granted: consentRecords.granted })
      .from(consentRecords)
      .where(and(eq(consentRecords.userId, userId), eq(consentRecords.consentType, consentType)))
      .orderBy(desc(consentRecords.createdAt))
      .limit(1);
    return row?.granted ?? false;
  }
}
