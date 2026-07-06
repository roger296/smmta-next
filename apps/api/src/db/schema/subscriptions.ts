/**
 * Subscriptions — Mollie mandates; worker-driven billing (SPEC §13.7, F4, §15.4).
 *
 * The Mollie mandate is payment authority only; the billing schedule, dunning,
 * and flexibility layer (credits, skip/swap/pause) are OURS. `credit_balance_pence`
 * is money in integer pence. Enum style follows THE SPEC's text-enum.
 */
import { pgTable, uuid, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';
import { storefrontUsers } from './identity.js';

export const subscriptions = pgTable('subscriptions', {
  id: pk(),
  companyId: companyId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => storefrontUsers.id),
  mollieCustomerId: text('mollie_customer_id').notNull(),
  mollieMandateId: text('mollie_mandate_id'), // set once the first payment clears
  plan: text('plan').notNull(),
  status: text('status', {
    enum: ['active', 'past_due', 'paused', 'cancelled'],
  }).notNull(),
  creditBalancePence: integer('credit_balance_pence').notNull().default(0),
  renewsAt: timestamp('renews_at', { withTimezone: true }),
  // Dunning (§16.4): retry ladder state while past_due.
  dunningAttempts: integer('dunning_attempts').notNull().default(0),
  firstFailedAt: timestamp('first_failed_at', { withTimezone: true }),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptionEvents = pgTable('subscription_events', {
  id: pk(),
  companyId: companyId(),
  subscriptionId: uuid('subscription_id')
    .notNull()
    .references(() => subscriptions.id),
  kind: text('kind', {
    enum: ['skip', 'swap', 'pause', 'resume', 'credit_spend', 'credit_grant'],
  }).notNull(),
  /** Signed pence delta for credit_grant (+) / credit_spend (−); null for others. */
  amountPence: integer('amount_pence'),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
