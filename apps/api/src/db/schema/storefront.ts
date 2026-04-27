import { pgTable, jsonb, timestamp, varchar, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps, sourceChannelEnum, reservationStatusEnum } from './common.js';
import { stockItems } from './products.js';

// ============================================================
// Stock Reservations
// ------------------------------------------------------------
// Short-lived hold on stock_items for a single customer's checkout.
// Created when checkout starts; converted to ALLOCATED on order
// commit; released on cart abandonment or payment failure; expired
// by a periodic job once `expires_at` passes.
// ============================================================

export interface ReservationMetadata {
  /** Storefront cart/checkout identifier. */
  checkoutId?: string;
  /** Mollie payment association. */
  mollie?: { paymentId?: string };
  // Free-form for future use; the storefront can attach anything.
  [key: string]: unknown;
}

export const stockReservations = pgTable('stock_reservations', {
  id: pk(),
  companyId: companyId(),
  sourceChannel: sourceChannelEnum('source_channel').notNull().default('API'),
  status: reservationStatusEnum('status').notNull().default('HELD'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  metadata: jsonb('metadata').$type<ReservationMetadata>(),
  ...auditTimestamps,
});

export const stockReservationsRelations = relations(stockReservations, ({ many }) => ({
  stockItems: many(stockItems),
}));

// ============================================================
// Storefront Idempotency
// ------------------------------------------------------------
// Stores `(company_id, idempotency_key) → response` so a retried
// `POST /storefront/orders` returns the original response and never
// creates a second order. Composite unique on (company_id, idempotency_key).
// Rows are insert-once: the response body is captured at the moment
// the original work succeeded (or deterministically failed) and is
// replayed verbatim for any subsequent request with the same key.
// ============================================================

export const storefrontIdempotency = pgTable(
  'storefront_idempotency',
  {
    id: pk(),
    companyId: companyId(),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    ...auditTimestamps,
  },
  (t) => ({
    storefrontIdempotencyCompanyKeyUnq: uniqueIndex(
      'storefront_idempotency_company_id_key_unq',
    ).on(t.companyId, t.idempotencyKey),
  }),
);
