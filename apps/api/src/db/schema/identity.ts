/**
 * Storefront customer identity & consent (SPEC §13.2, F9).
 *
 * Naming adaptation (BUILD_LOG entry 2): THE SPEC calls the canonical customer
 * record `users`, but the repo already has a `users` table for ADMIN operators
 * (email + password + roles → JWT). To avoid the collision this table is
 * `storefront_users` (Drizzle export `storefrontUsers`); the spec's design is
 * otherwise preserved exactly — the person is separated from login methods
 * (`auth_identities`), merge keys on verified email, and consent is append-only.
 *
 * Enum style: THE SPEC defines these tables with Drizzle `text(.., { enum })`
 * (its §13.1 rationale: cheaper to extend than pg enums). Followed here for the
 * new tables, a deliberate divergence from the repo's `pgEnum` convention —
 * logged in BUILD_LOG entry 2.
 */
import { pgTable, uuid, text, varchar, timestamp, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';

/** The person — canonical customer record. Guest tier = a row here with no
 *  `auth_identities` row. `merged_into` is set on the losing record after an
 *  identity merge; it NEVER cascades a delete (order-history FKs must survive). */
export const storefrontUsers = pgTable('storefront_users', {
  id: pk(),
  companyId: companyId(),
  email: varchar('email', { length: 320 }).unique(),
  emailVerified: timestamp('email_verified', { withTimezone: true }), // merge keys off this
  displayName: varchar('display_name', { length: 200 }),
  kind: text('kind', { enum: ['guest', 'account', 'trade'] }).notNull().default('guest'),
  mergedInto: uuid('merged_into'), // self-reference; no FK cascade by design
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Login methods, FK → storefront_users. Merge on verified email. */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: pk(),
    companyId: companyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => storefrontUsers.id),
    provider: text('provider', { enum: ['google', 'facebook', 'email'] }).notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqProviderAccount: uniqueIndex('uq_provider_account').on(t.provider, t.providerAccountId),
  }),
);

/**
 * APPEND-ONLY. Current consent = latest row per (user, type). This is the PECR
 * evidence trail; never UPDATE or DELETE. Enforced by a DB trigger added in the
 * migration (`consent_records_append_only`) that raises on UPDATE/DELETE.
 */
export const consentRecords = pgTable('consent_records', {
  id: pk(),
  companyId: companyId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => storefrontUsers.id),
  consentType: text('consent_type', {
    enum: ['flag_updates', 'general_marketing'],
  }).notNull(),
  granted: boolean('granted').notNull(), // false row = revocation
  source: text('source').notNull(), // page/action that captured it
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Mutable fast-path cache: "can I email this address right now". Fed by SendGrid
 * webhooks + consent revocations; checked by send-message (§12.1 rule 5).
 */
export const suppressionList = pgTable('suppression_list', {
  email: varchar('email', { length: 320 }).primaryKey(),
  companyId: companyId(),
  reason: text('reason', {
    enum: ['bounce', 'complaint', 'unsubscribe', 'manual'],
  }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
