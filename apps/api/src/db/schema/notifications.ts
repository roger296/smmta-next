/**
 * Stock-back-in-stock notifications + the newsletter list it can opt
 * customers into.
 *
 * `stock_notifications` is a customer queue: one row per (productId, email)
 * while a request is pending. The unique index is partial — only rows
 * where `fulfilled_at IS NULL` are constrained — so a customer who
 * subscribed, was notified, and then the SKU went OOS again can re-enrol
 * without colliding with their old fulfilled row.
 *
 * `newsletter_subscribers` is a long-lived marketing list. Anyone who
 * ticked the "subscribe" box on the notify-me form gets added here with
 * `source = 'stock_notification'`. Unsubscribe lives behind a token-
 * based URL that is rendered into newsletter footers — that flow is
 * out of scope for this PR but the column is here so the next PR can
 * wire it up.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { auditTimestamps, companyId, pk } from './common.js';
import { products } from './products.js';

export const stockNotifications = pgTable(
  'stock_notifications',
  {
    id: pk(),
    companyId: companyId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    subscribedToNewsletter: boolean('subscribed_to_newsletter')
      .notNull()
      .default(false),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the back-in-stock email has been dispatched. NULL =
     *  pending. The unique index below treats NULL rows as constrained
     *  per (productId, email); fulfilled rows are unconstrained so a
     *  customer can re-enrol after a future stock-out. */
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (t) => ({
    stockNotificationsPendingUnq: uniqueIndex('stock_notifications_pending_unq')
      .on(t.productId, t.email)
      .where(sql`fulfilled_at IS NULL AND deleted_at IS NULL`),
  }),
);

export const newsletterSubscribers = pgTable(
  'newsletter_subscribers',
  {
    id: pk(),
    companyId: companyId(),
    email: varchar('email', { length: 320 }).notNull(),
    /** Where this subscription came from — e.g. `stock_notification`,
     *  `footer_signup`. Useful for reporting and for tailoring future
     *  messages by acquisition source. */
    source: varchar('source', { length: 64 }).notNull(),
    subscribedAt: timestamp('subscribed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    /** Random 32-byte hex; rendered into newsletter-email footers as
     *  `https://<store>/unsubscribe/<token>`. The unsubscribe page is a
     *  follow-up PR — column exists now to avoid a second migration. */
    unsubscribeToken: varchar('unsubscribe_token', { length: 64 })
      .notNull()
      .unique(),
    ...auditTimestamps,
  },
  (t) => ({
    newsletterSubscribersEmailUnq: uniqueIndex(
      'newsletter_subscribers_email_unq',
    ).on(t.email),
  }),
);
