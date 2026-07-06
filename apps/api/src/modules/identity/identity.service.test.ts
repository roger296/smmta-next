/**
 * Identity + consent service tests (Prompt 3, SPEC F9, §13.2).
 * Real Postgres at DATABASE_URL.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  authIdentities,
  consentRecords,
  interestFlags,
  domainEvents,
} from '../../db/schema/index.js';
import { IdentityService, pickSurvivor, type UserRow } from './identity.service.js';
import { ConsentService } from './consent.service.js';

const COMPANY = getSingletonCompanyId();
const identity = new IdentityService();
const consent = new ConsentService();

let n = 0;
const email = (tag: string) => `idt-${tag}-${++n}@example.test`;

async function eventsFor(userId: string, type?: string) {
  const db = getDb();
  const conds = [eq(domainEvents.aggregateId, userId)];
  if (type) conds.push(eq(domainEvents.eventType, type));
  return db.select().from(domainEvents).where(and(...conds));
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.execute(sql`ALTER TABLE consent_records DISABLE TRIGGER consent_records_no_delete`);
  await db.execute(sql`ALTER TABLE consent_records DISABLE TRIGGER consent_records_no_update`);
  try {
    const users = await db
      .select({ id: storefrontUsers.id })
      .from(storefrontUsers)
      .where(like(storefrontUsers.email, 'idt-%@example.test'));
    // Also catch merge losers whose email may be null but merged_into points at a test user.
    const ids = users.map((u) => u.id);
    if (ids.length) {
      await db.delete(consentRecords).where(inArray(consentRecords.userId, ids));
      await db.delete(interestFlags).where(inArray(interestFlags.userId, ids));
      await db.delete(authIdentities).where(inArray(authIdentities.userId, ids));
      await db.delete(domainEvents).where(inArray(domainEvents.aggregateId, ids));
      // Null out any merged_into pointing at these so we can delete freely.
      await db
        .update(storefrontUsers)
        .set({ mergedInto: null })
        .where(inArray(storefrontUsers.mergedInto, ids));
      await db.delete(storefrontUsers).where(inArray(storefrontUsers.id, ids));
    }
  } finally {
    await db.execute(sql`ALTER TABLE consent_records ENABLE TRIGGER consent_records_no_delete`);
    await db.execute(sql`ALTER TABLE consent_records ENABLE TRIGGER consent_records_no_update`);
  }
}

afterEach(cleanup);
afterAll(async () => {
  await closeDatabase();
});

describe('captureGuest', () => {
  it('creates a guest and is idempotent on repeat email; emits user.created', async () => {
    const e = email('guest');
    const first = await identity.captureGuest(e);
    expect(first.kind).toBe('guest');
    const again = await identity.captureGuest(e);
    expect(again.id).toBe(first.id); // no duplicate, no error
    const created = await eventsFor(first.id, 'user.created');
    expect(created).toHaveLength(1);
  });
});

describe('ConsentService', () => {
  it('currentConsent reflects the latest row across grant/revoke, defaulting false', async () => {
    const user = await identity.captureGuest(email('consent'));
    expect(await consent.currentConsent(user.id, 'general_marketing')).toBe(false);

    await consent.grant(user.id, 'general_marketing', 'test');
    expect(await consent.currentConsent(user.id, 'general_marketing')).toBe(true);

    await consent.revoke(user.id, 'general_marketing', 'test');
    expect(await consent.currentConsent(user.id, 'general_marketing')).toBe(false);

    // Both a grant and a revoke event landed in the outbox.
    expect(await eventsFor(user.id, 'consent.granted')).toHaveLength(1);
    expect(await eventsFor(user.id, 'consent.revoked')).toHaveLength(1);
  });
});

describe('pickSurvivor', () => {
  const mk = (kind: UserRow['kind'], createdAt: Date): UserRow =>
    ({ id: `${kind}-${createdAt.getTime()}`, kind, createdAt } as UserRow);

  it('account beats guest regardless of age', () => {
    const guestOlder = mk('guest', new Date('2020-01-01'));
    const account = mk('account', new Date('2026-01-01'));
    const [survivor] = pickSurvivor(guestOlder, account);
    expect(survivor.kind).toBe('account');
  });

  it('between two accounts, the older created_at survives', () => {
    const older = mk('account', new Date('2024-01-01'));
    const newer = mk('account', new Date('2026-01-01'));
    const [survivor] = pickSurvivor(newer, older);
    expect(survivor.createdAt).toEqual(older.createdAt);
  });
});

describe('mergeUsers', () => {
  it('guest → account: account survives, loser stamped, FKs re-pointed, consent carried, event emitted', async () => {
    const db = getDb();
    const account = await identity.captureGuest(email('acc'));
    await db.update(storefrontUsers).set({ kind: 'account' }).where(eq(storefrontUsers.id, account.id));
    const guest = await identity.captureGuest(email('gst'));

    // Give the guest an interest flag + a marketing consent.
    await db.insert(interestFlags).values({
      companyId: COMPANY,
      userId: guest.id,
      sku: 'FIL-PLA-BLK-175',
      flagType: 'restock',
    });
    await consent.grant(guest.id, 'general_marketing', 'test');

    const survivor = await identity.mergeUsers(account.id, guest.id);
    expect(survivor.id).toBe(account.id); // account beats guest

    const [loser] = await db.select().from(storefrontUsers).where(eq(storefrontUsers.id, guest.id));
    expect(loser!.mergedInto).toBe(account.id);

    // The guest's flag now belongs to the survivor.
    const flags = await db.select().from(interestFlags).where(eq(interestFlags.userId, account.id));
    expect(flags.some((f) => f.sku === 'FIL-PLA-BLK-175')).toBe(true);

    // Consent carried forward to survivor.
    expect(await consent.currentConsent(account.id, 'general_marketing')).toBe(true);

    const merged = await eventsFor(account.id, 'user.merged');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.payload).toMatchObject({ survivingId: account.id, mergedId: guest.id });
  });

  it('account → account: the older created_at survives', async () => {
    const db = getDb();
    const older = await identity.captureGuest(email('old'));
    const newer = await identity.captureGuest(email('new'));
    await db
      .update(storefrontUsers)
      .set({ kind: 'account', createdAt: new Date('2024-01-01T00:00:00Z') })
      .where(eq(storefrontUsers.id, older.id));
    await db
      .update(storefrontUsers)
      .set({ kind: 'account', createdAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(storefrontUsers.id, newer.id));

    const survivor = await identity.mergeUsers(newer.id, older.id);
    expect(survivor.id).toBe(older.id);
  });
});

describe('findOrCreateForProvider', () => {
  it('no match → creates a new account user + identity + user.created', async () => {
    const e = email('prov-new');
    const user = await identity.findOrCreateForProvider({
      provider: 'google',
      providerAccountId: `g-${e}`,
      email: e,
      emailVerified: true,
      displayName: 'New Person',
    });
    expect(user.kind).toBe('account');
    expect(user.emailVerified).not.toBeNull();
    expect(await eventsFor(user.id, 'user.created')).toHaveLength(1);
  });

  it('verified email matches an existing guest → links identity and upgrades to account', async () => {
    const e = email('prov-link');
    const guest = await identity.captureGuest(e);
    expect(guest.kind).toBe('guest');

    const resolved = await identity.findOrCreateForProvider({
      provider: 'google',
      providerAccountId: `g-${e}`,
      email: e,
      emailVerified: true,
    });
    expect(resolved.id).toBe(guest.id); // same person
    expect(resolved.kind).toBe('account'); // upgraded
    expect(resolved.emailVerified).not.toBeNull();

    // The identity was linked; a second resolve returns the same user.
    const again = await identity.findOrCreateForProvider({
      provider: 'google',
      providerAccountId: `g-${e}`,
    });
    expect(again.id).toBe(guest.id);
  });
});
