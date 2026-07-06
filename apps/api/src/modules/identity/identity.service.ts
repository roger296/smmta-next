/**
 * Identity service (SPEC F9, §13.2, §13.8).
 *
 * The person is separated from login methods: `storefront_users` (the person)
 * + `auth_identities` (google/facebook/email logins). Guest tier = a
 * storefront_users row with no auth_identities row. On a provider login whose
 * verified email matches an existing user, the two collapse to one — merge
 * keeps the account over a guest, else the oldest created_at.
 *
 * Survivor rule (exact, logged in BUILD_LOG): if exactly one of the pair is a
 * non-guest (account/trade) → that one survives; otherwise the older
 * created_at survives.
 *
 * consent_records is append-only, so a merge cannot re-point consent rows by
 * UPDATE. Instead the survivor's consent is carried forward as NEW rows for any
 * consent type the survivor has no record of (the loser's rows stay as PECR
 * evidence). All other user-owned FKs are re-pointed by UPDATE.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  authIdentities,
  consentRecords,
  interestFlags,
  chatSessions,
  messageDrafts,
  subscriptions,
} from '../../db/schema/index.js';
import { emitDomainEvent, type DbTx } from '../../shared/events/emit.js';

export type UserRow = typeof storefrontUsers.$inferSelect;
export type AuthProvider = 'google' | 'facebook' | 'email';

/** Pick [survivor, loser] between two users per the merge rule. */
export function pickSurvivor(a: UserRow, b: UserRow): [UserRow, UserRow] {
  const aAccount = a.kind !== 'guest';
  const bAccount = b.kind !== 'guest';
  if (aAccount !== bAccount) return aAccount ? [a, b] : [b, a];
  return a.createdAt <= b.createdAt ? [a, b] : [b, a];
}

export class IdentityService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  private async findByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(storefrontUsers)
      .where(eq(storefrontUsers.email, email))
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(storefrontUsers)
      .where(eq(storefrontUsers.id, id))
      .limit(1);
    return row;
  }

  /**
   * Guest capture (e.g. from an interest-flag email form). Idempotent — never
   * errors on a repeat email; returns the existing user if present.
   */
  async captureGuest(email: string, source = 'guest_capture'): Promise<UserRow> {
    const existing = await this.findByEmail(email);
    if (existing) return existing;
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(storefrontUsers)
        .values({ companyId: this.companyId, email, kind: 'guest' })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) {
        await emitDomainEvent(tx, {
          eventType: 'user.created',
          aggregateType: 'user',
          aggregateId: inserted[0].id,
          payload: { source, kind: 'guest' },
        });
        return inserted[0];
      }
      // Lost an insert race — re-read the winner.
      const [row] = await tx
        .select()
        .from(storefrontUsers)
        .where(eq(storefrontUsers.email, email))
        .limit(1);
      return row!;
    });
  }

  /**
   * Resolve a provider login to a single storefront user (the Auth.js signIn
   * path). Order of resolution:
   *   1. Existing auth_identity for (provider, providerAccountId) → its user.
   *   2. A user with this verified email exists → link the identity, upgrade a
   *      guest to an account, mark verified.
   *   3. Otherwise create a fresh account user + identity.
   * Emits user.created for a brand-new user.
   */
  async findOrCreateForProvider(input: {
    provider: AuthProvider;
    providerAccountId: string;
    email?: string | null;
    emailVerified?: boolean;
    displayName?: string | null;
  }): Promise<UserRow> {
    const { provider, providerAccountId, email, emailVerified, displayName } = input;

    const [identity] = await this.db
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, provider),
          eq(authIdentities.providerAccountId, providerAccountId),
        ),
      )
      .limit(1);
    if (identity) {
      return (await this.findById(identity.userId))!;
    }

    const existing = email ? await this.findByEmail(email) : undefined;

    return this.db.transaction(async (tx) => {
      if (existing) {
        await tx
          .insert(authIdentities)
          .values({ companyId: this.companyId, userId: existing.id, provider, providerAccountId })
          .onConflictDoNothing();
        const patch: Partial<typeof storefrontUsers.$inferInsert> = {};
        if (existing.kind === 'guest') patch.kind = 'account';
        if (emailVerified && !existing.emailVerified) patch.emailVerified = new Date();
        if (displayName && !existing.displayName) patch.displayName = displayName;
        if (Object.keys(patch).length > 0) {
          await tx.update(storefrontUsers).set(patch).where(eq(storefrontUsers.id, existing.id));
        }
        return (await this.findByIdTx(tx, existing.id))!;
      }

      const [user] = await tx
        .insert(storefrontUsers)
        .values({
          companyId: this.companyId,
          email: email ?? null,
          kind: 'account',
          displayName: displayName ?? null,
          emailVerified: emailVerified ? new Date() : null,
        })
        .returning();
      await tx
        .insert(authIdentities)
        .values({ companyId: this.companyId, userId: user!.id, provider, providerAccountId });
      await emitDomainEvent(tx, {
        eventType: 'user.created',
        aggregateType: 'user',
        aggregateId: user!.id,
        payload: { source: `oauth:${provider}`, kind: 'account' },
      });
      return user!;
    });
  }

  private async findByIdTx(tx: DbTx, id: string): Promise<UserRow | undefined> {
    const [row] = await tx.select().from(storefrontUsers).where(eq(storefrontUsers.id, id)).limit(1);
    return row;
  }

  /**
   * Merge two user records into one, re-pointing all user-owned FKs (except
   * append-only consent, which is carried forward as new rows) and stamping the
   * loser's `merged_into`. Emits user.merged. Idempotent-ish: a no-op if either
   * id is missing or they are the same.
   */
  async mergeUsers(idA: string, idB: string): Promise<UserRow> {
    if (idA === idB) return (await this.findById(idA))!;
    const a = await this.findById(idA);
    const b = await this.findById(idB);
    if (!a || !b) throw new Error('mergeUsers: one or both users not found');

    const [survivor, loser] = pickSurvivor(a, b);

    return this.db.transaction(async (tx) => {
      // Re-point simple user FKs.
      await tx
        .update(authIdentities)
        .set({ userId: survivor.id })
        .where(eq(authIdentities.userId, loser.id));
      await tx
        .update(chatSessions)
        .set({ userId: survivor.id })
        .where(eq(chatSessions.userId, loser.id));
      await tx
        .update(messageDrafts)
        .set({ userId: survivor.id })
        .where(eq(messageDrafts.userId, loser.id));
      await tx
        .update(subscriptions)
        .set({ userId: survivor.id })
        .where(eq(subscriptions.userId, loser.id));

      // interest_flags has a (user, sku, prospective, flagType) unique index —
      // re-point only the flags that would not collide, then drop the rest.
      await tx.execute(sql`
        UPDATE interest_flags l SET user_id = ${survivor.id}
        WHERE l.user_id = ${loser.id}
          AND NOT EXISTS (
            SELECT 1 FROM interest_flags s
            WHERE s.user_id = ${survivor.id}
              AND s.flag_type = l.flag_type
              AND s.sku IS NOT DISTINCT FROM l.sku
              AND s.prospective_id IS NOT DISTINCT FROM l.prospective_id
          )`);
      await tx.delete(interestFlags).where(eq(interestFlags.userId, loser.id));

      // Carry forward consent (append-only): for each type the survivor has no
      // record of, mirror the loser's latest state as a new survivor row.
      await this.carryForwardConsent(tx, survivor.id, loser.id);

      // Stamp the loser; never delete (order-history FKs, evidence).
      await tx
        .update(storefrontUsers)
        .set({ mergedInto: survivor.id })
        .where(eq(storefrontUsers.id, loser.id));

      await emitDomainEvent(tx, {
        eventType: 'user.merged',
        aggregateType: 'user',
        aggregateId: survivor.id,
        payload: { survivingId: survivor.id, mergedId: loser.id },
      });

      return (await this.findByIdTx(tx, survivor.id))!;
    });
  }

  private async carryForwardConsent(tx: DbTx, survivorId: string, loserId: string): Promise<void> {
    for (const consentType of ['flag_updates', 'general_marketing'] as const) {
      const [survivorLatest] = await tx
        .select({ id: consentRecords.id })
        .from(consentRecords)
        .where(
          and(eq(consentRecords.userId, survivorId), eq(consentRecords.consentType, consentType)),
        )
        .limit(1);
      if (survivorLatest) continue; // survivor already has an explicit choice — keep it
      const [loserLatest] = await tx
        .select({ granted: consentRecords.granted })
        .from(consentRecords)
        .where(and(eq(consentRecords.userId, loserId), eq(consentRecords.consentType, consentType)))
        .orderBy(desc(consentRecords.createdAt))
        .limit(1);
      if (!loserLatest) continue;
      await tx.insert(consentRecords).values({
        companyId: this.companyId,
        userId: survivorId,
        consentType,
        granted: loserLatest.granted,
        source: `merge:${loserId}`,
      });
    }
  }

  /** All active (non-merged) users for the singleton company. */
  async listActive(): Promise<UserRow[]> {
    return this.db
      .select()
      .from(storefrontUsers)
      .where(and(eq(storefrontUsers.companyId, this.companyId), isNull(storefrontUsers.mergedInto)));
  }
}
