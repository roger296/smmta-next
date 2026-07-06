/**
 * Run-out predictions (SPEC F7, §12.3). Per (user, sku) purchase cadence,
 * recomputed nightly and read by the marketing-nightly segmentation.
 *
 * Adaptation (logged): the spec keys predictions on (user, material-category);
 * this uses (user, sku) as a testable proxy while the storefront-user↔order
 * linkage + a material taxonomy on products are still being built.
 */
import { pgTable, uuid, text, integer, timestamp, unique } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';
import { storefrontUsers } from './identity.js';

export const runOutPredictions = pgTable(
  'run_out_predictions',
  {
    id: pk(),
    companyId: companyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => storefrontUsers.id),
    sku: text('sku').notNull(),
    medianIntervalDays: integer('median_interval_days').notNull(),
    purchaseCount: integer('purchase_count').notNull(),
    lastPurchaseAt: timestamp('last_purchase_at', { withTimezone: true }).notNull(),
    predictedRunOutAt: timestamp('predicted_run_out_at', { withTimezone: true }).notNull(),
    regular: text('regular', { enum: ['yes', 'no'] }).notNull().default('no'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqRunOut: unique('uq_run_out_user_sku').on(t.userId, t.sku),
  }),
);
