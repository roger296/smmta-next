/**
 * Pre-order orders (SPEC §16). A self-contained representation of an order that
 * buys against unarrived shipment stock. The existing warehouse checkout
 * (customer_orders + stock_items reservations) can't model this — there are no
 * stock_items until goods-in — and §16.4's split-basket design already produces
 * a SEPARATE order for the pre-order half. Logged in BUILD_LOG entry 6.
 *
 * The band + £ savings are LOCKED onto each line at order time (§15.2 band-lock)
 * so a later pricing_rules change never reprices a placed order. Money is pence.
 */
import { pgTable, uuid, text, integer, timestamp, unique } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';
import { storefrontUsers } from './identity.js';

export const preorderOrders = pgTable(
  'preorder_orders',
  {
    id: pk(),
    companyId: companyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => storefrontUsers.id),
    status: text('status', {
      enum: ['awaiting_payment', 'paid', 'lapsed', 'cancelled', 'refund_pending', 'refunded'],
    })
      .notNull()
      .default('awaiting_payment'),
    /** Chosen method. >30-day orders are bank-only (§16.1). */
    paymentMethod: text('payment_method', {
      enum: ['bank', 'manual_transfer', 'card', 'wallet', 'paypal'],
    }).notNull(),
    paymentReference: text('payment_reference').notNull(),
    molliePaymentId: text('mollie_payment_id'),
    totalPence: integer('total_pence').notNull(),
    /** Set on the day-3 overdue notice so the window scan never re-notifies. */
    overdueNotifiedAt: timestamp('overdue_notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    lapsedAt: timestamp('lapsed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => ({
    uqPaymentReference: unique('uq_preorder_payment_reference').on(t.companyId, t.paymentReference),
  }),
);

export const preorderOrderLines = pgTable('preorder_order_lines', {
  id: pk(),
  companyId: companyId(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => preorderOrders.id),
  shipmentId: uuid('shipment_id').notNull(),
  poolRef: text('pool_ref').notNull(), // inbound shipment reference
  sku: text('sku').notNull(),
  qty: integer('qty').notNull(),
  // Locked at order time (§15.2) — survives later pricing_rules changes.
  lockedUnitPricePence: integer('locked_unit_price_pence').notNull(),
  lockedBandBp: integer('locked_band_bp').notNull(),
  lockedSavingPence: integer('locked_saving_pence').notNull(),
});
