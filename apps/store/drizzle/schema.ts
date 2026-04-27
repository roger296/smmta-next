/**
 * Storefront database schema — `smmta_store` Postgres database.
 *
 * Owned entirely by the storefront. SMMTA-NEXT does **not** read from these
 * tables; conversely the storefront never touches the SMMTA-NEXT DB. Every
 * cross-system call is a server-to-server HTTP request authenticated with
 * the api-key surface from Prompt 2.
 *
 * Tables (per architecture document §11):
 *   carts                  — cookie-id-keyed shopping baskets
 *   cart_items             — basket lines with price snapshots
 *   checkouts              — in-flight checkout drafts
 *   mollie_payments        — what we believe Mollie thinks (re-fetched on webhook)
 *   mollie_refunds         — refund records linked to credit notes
 *   webhook_deliveries     — raw audit log of every Mollie / SendGrid webhook
 *   idempotency_keys       — outbound-call dedupe (storefront-side)
 *   email_outbox           — transactional email queue
 *
 * Schema lives at the top-level `drizzle/` per the architecture. Migrations
 * land in `drizzle/migrations/` via `drizzle-kit generate`.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  decimal,
  boolean,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Shared helpers (kept inline — the storefront DB is small enough that
// pulling these into a `common.ts` would be over-engineering for v1.)
// ---------------------------------------------------------------------------

const pk = () => uuid('id').primaryKey().defaultRandom();
const auditTimestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const checkoutStatusEnum = pgEnum('checkout_status', [
  'OPEN',
  'RESERVED',
  'PAYING',
  'COMMITTED',
  'FAILED',
  'ABANDONED',
]);

export const mollieStatusEnum = pgEnum('mollie_status', [
  'open',
  'pending',
  'authorized',
  'paid',
  'canceled',
  'expired',
  'failed',
  'refunded',
  'partially_refunded',
]);

export const webhookSourceEnum = pgEnum('webhook_source', ['mollie', 'sendgrid']);

export const emailSendStatusEnum = pgEnum('email_send_status', [
  'PENDING',
  'SENT',
  'FAILED',
]);

// ---------------------------------------------------------------------------
// carts + cart_items
// ---------------------------------------------------------------------------

/** A cart belongs to a signed `cart_id` cookie. Soft-deleted on order commit. */
export const carts = pgTable('carts', {
  id: pk(),
  /** Currency the cart is priced in. v1 is GBP. */
  currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
  /** Cached gross subtotal across cart_items. Source of truth is the items
   *  table; this exists only as a fast read for the cart drawer. */
  totalsCacheGbp: decimal('totals_cache_gbp', { precision: 18, scale: 2 })
    .notNull()
    .default('0'),
  ...auditTimestamps,
  /** Set when the cart's checkout commits to an order. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const cartItems = pgTable(
  'cart_items',
  {
    id: pk(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    /** Product UUID in SMMTA-NEXT — opaque to the storefront DB. */
    productId: uuid('product_id').notNull(),
    quantity: integer('quantity').notNull(),
    /** Price-per-unit at the moment the line was added. The cart honours this
     *  snapshot until the customer re-adds the item — see Prompt 9. */
    priceSnapshotGbp: decimal('price_snapshot_gbp', { precision: 18, scale: 2 }).notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditTimestamps,
  },
  (t) => ({
    cartItemsCartIdx: index('cart_items_cart_id_idx').on(t.cartId),
  }),
);

// ---------------------------------------------------------------------------
// checkouts — in-flight checkout drafts
// ---------------------------------------------------------------------------

export const checkouts = pgTable(
  'checkouts',
  {
    id: pk(),
    cartId: uuid('cart_id').references(() => carts.id),
    status: checkoutStatusEnum('status').notNull().default('OPEN'),
    /** SMMTA-NEXT reservationId once we've reserved stock. Null until then. */
    reservationId: uuid('reservation_id'),
    /** Mollie payment id (`tr_xxx`) once we've created a payment. */
    molliePaymentId: varchar('mollie_payment_id', { length: 100 }),
    /** Idempotency-Key used on the SMMTA POST /storefront/orders call. */
    idempotencyKey: varchar('idempotency_key', { length: 200 }),
    /** SMMTA orderId once the order commit succeeds. */
    smmtaOrderId: uuid('smmta_order_id'),
    /** Captured customer + addresses (we don't have a separate addresses
     *  table — the storefront only hangs onto these long enough to send to
     *  SMMTA on commit). */
    customer: jsonb('customer').$type<{
      email: string;
      firstName: string;
      lastName: string;
      phone?: string;
    } | null>(),
    deliveryAddress: jsonb('delivery_address').$type<Record<string, unknown> | null>(),
    invoiceAddress: jsonb('invoice_address').$type<Record<string, unknown> | null>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (t) => ({
    checkoutsCartIdx: index('checkouts_cart_id_idx').on(t.cartId),
    checkoutsMollieIdx: uniqueIndex('checkouts_mollie_payment_id_unq').on(t.molliePaymentId),
  }),
);

// ---------------------------------------------------------------------------
// mollie_payments — source of truth for what we believe Mollie thinks
// ---------------------------------------------------------------------------

export const molliePayments = pgTable('mollie_payments', {
  /** Mollie's `tr_xxx` id. */
  id: varchar('id', { length: 100 }).primaryKey(),
  checkoutId: uuid('checkout_id')
    .notNull()
    .references(() => checkouts.id),
  amountGbp: decimal('amount_gbp', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('GBP'),
  method: varchar('method', { length: 50 }),
  status: mollieStatusEnum('status').notNull().default('open'),
  /** Last full payload re-fetched from Mollie. The webhook body is never
   *  trusted; we always re-fetch /v2/payments/:id and store that here. */
  rawPayload: jsonb('raw_payload').$type<Record<string, unknown> | null>(),
  ...auditTimestamps,
});

// ---------------------------------------------------------------------------
// mollie_refunds — refund records linked to a SMMTA credit note
// ---------------------------------------------------------------------------

export const mollieRefunds = pgTable('mollie_refunds', {
  /** Mollie's `re_xxx` id. */
  id: varchar('id', { length: 100 }).primaryKey(),
  paymentId: varchar('payment_id', { length: 100 })
    .notNull()
    .references(() => molliePayments.id),
  /** Link back to the SMMTA credit_notes row. The storefront doesn't read
   *  this back — it's stored so operators can correlate. */
  smmtaCreditNoteId: uuid('smmta_credit_note_id'),
  amountGbp: decimal('amount_gbp', { precision: 18, scale: 2 }).notNull(),
  status: varchar('status', { length: 50 }).notNull(),
  rawPayload: jsonb('raw_payload').$type<Record<string, unknown> | null>(),
  ...auditTimestamps,
});

// ---------------------------------------------------------------------------
// webhook_deliveries — raw audit log
// ---------------------------------------------------------------------------

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: pk(),
    source: webhookSourceEnum('source').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Raw body verbatim. URL-encoded for Mollie, JSON for SendGrid events. */
    rawBody: text('raw_body').notNull(),
    /** True if signature / re-fetch matched (Mollie re-fetch, SendGrid sig). */
    signatureOk: boolean('signature_ok').notNull().default(false),
    /** What we believe Mollie thinks the payment status is, after re-fetch. */
    fetchedPaymentStatus: varchar('fetched_payment_status', { length: 50 }),
    /** Free-form description of what happened (e.g. "committed order ord_xxx"). */
    actionTaken: text('action_taken'),
    error: text('error'),
  },
  (t) => ({
    webhookDeliveriesSourceIdx: index('webhook_deliveries_source_idx').on(t.source),
  }),
);

// ---------------------------------------------------------------------------
// idempotency_keys — outbound-call dedupe (storefront-side)
// ---------------------------------------------------------------------------

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    /** The supplied key. We compose it from checkoutId in most call sites. */
    key: varchar('key', { length: 200 }).notNull(),
    /** Scope namespace ("smmta-orders", "mollie-payments", …) so the same
     *  key can be used safely against multiple downstream services. */
    scope: varchar('scope', { length: 100 }).notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idempotencyKeysPk: uniqueIndex('idempotency_keys_pk').on(t.key, t.scope),
  }),
);

// ---------------------------------------------------------------------------
// email_outbox — transactional email queue
// ---------------------------------------------------------------------------

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: pk(),
    toEmail: varchar('to_email', { length: 200 }).notNull(),
    template: varchar('template', { length: 100 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    sendStatus: emailSendStatusEnum('send_status').notNull().default('PENDING'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
    /** Optional link back to a SMMTA orderId — used to enforce
     *  "no duplicate confirmation per order" via a unique partial index. */
    orderId: uuid('order_id'),
    ...auditTimestamps,
  },
  (t) => ({
    emailOutboxOrderTemplateUnq: uniqueIndex('email_outbox_order_template_unq').on(
      t.orderId,
      t.template,
    ),
    emailOutboxStatusIdx: index('email_outbox_send_status_idx').on(t.sendStatus),
  }),
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const cartsRelations = relations(carts, ({ many }) => ({
  items: many(cartItems),
  checkouts: many(checkouts),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, { fields: [cartItems.cartId], references: [carts.id] }),
}));

export const checkoutsRelations = relations(checkouts, ({ one, many }) => ({
  cart: one(carts, { fields: [checkouts.cartId], references: [carts.id] }),
  payments: many(molliePayments),
}));

export const molliePaymentsRelations = relations(molliePayments, ({ one, many }) => ({
  checkout: one(checkouts, {
    fields: [molliePayments.checkoutId],
    references: [checkouts.id],
  }),
  refunds: many(mollieRefunds),
}));

export const mollieRefundsRelations = relations(mollieRefunds, ({ one }) => ({
  payment: one(molliePayments, {
    fields: [mollieRefunds.paymentId],
    references: [molliePayments.id],
  }),
}));
