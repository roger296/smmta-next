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
  decimal,
  integer,
  jsonb,
  pgTable,
  text,
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

// ============================================================
// LLM-backed conversational search log
// ============================================================
//
// One row per customer search query that hit the conversational
// parser. Used for:
//   - Daily-spend tracking (the cost-ceiling fall-back to keyword
//     search if the day's spend exceeds the configured budget).
//   - Admin SPA "search insights" page (top queries, zero-result
//     queries, average confidence, average latency).
//   - Future fine-tuning / prompt-tweaking (no PII; the customer's
//     query text is the only customer-supplied data captured).
//
// Deliberately NO customer identifier (no email, IP, session id).
// The log is for tuning the system, not analytics on individual
// customers.

export const llmSearchLog = pgTable(
  'llm_search_log',
  {
    id: pk(),
    companyId: companyId(),
    /** The raw customer query string. Capped via the search endpoint's
     *  Zod schema so the column doesn't need to be unlimited. */
    query: text('query').notNull(),
    /** SHA-256 of the lowercased + trimmed query. Lets us count
     *  duplicate queries across the cache window without storing the
     *  raw string a second time. */
    queryHash: varchar('query_hash', { length: 64 }).notNull(),
    /** Parsed output as returned by the LLM (or null if the parser
     *  fell through to keyword search). Stored verbatim so we can
     *  audit the model's interpretation later. */
    parsedOutput: jsonb('parsed_output'),
    /** `'high' | 'medium' | 'low'` from the parser, or null when the
     *  parser wasn't called (cache hit / budget exceeded). */
    confidence: varchar('confidence', { length: 10 }),
    /** Number of products returned for this query. Used to find
     *  zero-result queries that need rule / synonym additions. */
    resultCount: integer('result_count').notNull().default(0),
    /** Total wall-clock latency for the search, including the LLM
     *  call + DB query + any cache lookup. Milliseconds. */
    latencyMs: integer('latency_ms').notNull().default(0),
    /** Whether the cache served this query. */
    cacheHit: boolean('cache_hit').notNull().default(false),
    /** Estimated cost in GBP for this query's LLM tokens. Zero on
     *  cache hits + keyword-fallback paths. */
    costGbp: decimal('cost_gbp', { precision: 8, scale: 6 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Time-bucketed reads dominate this table: "today's spend total",
    // "queries this week", "top zero-result queries". Index on createdAt.
    llmSearchLogCreatedIdx: uniqueIndex('llm_search_log_created_id_unq').on(
      t.createdAt,
      t.id,
    ),
  }),
);
