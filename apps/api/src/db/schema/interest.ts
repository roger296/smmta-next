/**
 * Interest flags & prospective products (SPEC §13.3, F8).
 *
 * The demand-signal registry: one contextual button (restock / offers /
 * register_interest) writing here + emitting domain events. Money in integer
 * pence. Enum style follows THE SPEC's text-enum (see identity.ts note).
 */
import { pgTable, uuid, text, integer, timestamp, unique } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';
import { storefrontUsers } from './identity.js';

/** The "coming soon" catalogue of products under consideration. */
export const prospectiveProducts = pgTable('prospective_products', {
  id: pk(),
  companyId: companyId(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status', {
    enum: ['considering', 'group_buy_open', 'ordered', 'ranged', 'abandoned'],
  })
    .notNull()
    .default('considering'),
  interestThreshold: integer('interest_threshold'), // flags needed to trigger action
  /** Set once when the threshold is first crossed — makes interest.threshold_crossed
   *  idempotent (§ Prompt 7). Null until crossed. */
  thresholdCrossedAt: timestamp('threshold_crossed_at', { withTimezone: true }),
  depositPence: integer('deposit_pence'), // optional refundable deposit tier [OPEN]
  creatorPartner: text('creator_partner'), // colourway campaigns
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const interestFlags = pgTable(
  'interest_flags',
  {
    id: pk(),
    companyId: companyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => storefrontUsers.id),
    sku: text('sku'), // set for ranged products
    prospectiveId: uuid('prospective_id').references(() => prospectiveProducts.id),
    flagType: text('flag_type', {
      enum: ['restock', 'offers', 'register_interest'],
    }).notNull(),
    depositPaidPence: integer('deposit_paid_pence'), // stratifies curious vs committed
    sourcePage: text('source_page'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }), // notified / converted / cancelled
  },
  (t) => ({
    // NULLS NOT DISTINCT so (user, NULL sku, prospectiveId, flagType) still
    // dedups — a plain Postgres unique index treats NULLs as distinct, which
    // would let duplicate watches through for prospective-only flags.
    uqFlag: unique('uq_flag')
      .on(t.userId, t.sku, t.prospectiveId, t.flagType)
      .nullsNotDistinct(),
  }),
);
