import {
  pgEnum,
  uuid,
  timestamp,
  bigint,
  varchar,
} from 'drizzle-orm/pg-core';

// ============================================================
// Shared enums
// ============================================================

export const orderStatusEnum = pgEnum('order_status', [
  'DRAFT', 'CONFIRMED', 'ALLOCATED', 'PARTIALLY_ALLOCATED',
  'BACK_ORDERED', 'READY_TO_SHIP', 'PARTIALLY_SHIPPED',
  'SHIPPED', 'INVOICED', 'COMPLETED', 'CANCELLED', 'ON_HOLD',
]);

export const sourceChannelEnum = pgEnum('source_channel', [
  'MANUAL', 'SHOPIFY', 'AMAZON', 'EBAY', 'ETSY', 'WOOCOMMERCE', 'CSV', 'API',
]);

// Stock item status. RESERVED sits between IN_STOCK and ALLOCATED — held
// against an open `stock_reservations` row for the duration of a checkout.
// See `apps/api/src/db/schema/storefront.ts` and the reservation service.
export const stockItemStatusEnum = pgEnum('stock_item_status', [
  'IN_STOCK', 'RESERVED', 'ALLOCATED', 'SOLD', 'RETURNED', 'WRITTEN_OFF', 'IN_TRANSIT',
]);

// Lifecycle of a stock_reservations row. HELD is the only state in which
// stock_items.reservation_id remains pointing at the reservation.
export const reservationStatusEnum = pgEnum('reservation_status', [
  'HELD', 'RELEASED', 'CONVERTED', 'EXPIRED',
]);

export const productTypeEnum = pgEnum('product_type', ['PHYSICAL', 'SERVICE']);

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOIDED',
]);

export const creditNoteStatusEnum = pgEnum('credit_note_status', [
  'DRAFT', 'ISSUED', 'ALLOCATED', 'VOIDED',
]);

export const poDeliveryStatusEnum = pgEnum('po_delivery_status', [
  'PENDING', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CANCELLED',
]);

export const poInvoiceStatusEnum = pgEnum('po_invoice_status', [
  'NOT_INVOICED', 'PARTIALLY_INVOICED', 'FULLY_INVOICED',
]);

export const grnStatusEnum = pgEnum('grn_status', ['PENDING', 'COMPLETED']);

export const supplierInvoiceStatusEnum = pgEnum('supplier_invoice_status', [
  'DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOIDED',
]);

export const allocationItemTypeEnum = pgEnum('allocation_item_type', [
  'INVOICE', 'CREDIT_NOTE', 'PAYMENT',
  'SUPPLIER_INVOICE', 'SUPPLIER_CREDIT_NOTE', 'SUPPLIER_PAYMENT',
]);

export const vatTreatmentEnum = pgEnum('vat_treatment', [
  'STANDARD_VAT_20', 'REDUCED_VAT_5', 'ZERO_RATED',
  'EXEMPT', 'OUTSIDE_SCOPE', 'REVERSE_CHARGE', 'POSTPONED_VAT',
]);

export const supplierAddressTypeEnum = pgEnum('supplier_address_type', [
  'INVOICE', 'WAREHOUSE',
]);

export const glPostingStatusEnum = pgEnum('gl_posting_status', [
  'PENDING', 'SUCCESS', 'FAILED', 'RETRYING',
]);

// ============================================================
// Shared column helpers
// ============================================================

/** Standard primary key */
export const pk = () => uuid('id').primaryKey().defaultRandom();

/** Multi-tenancy company column */
export const companyId = () => uuid('company_id').notNull();

/** Soft-delete + audit timestamps */
export const auditTimestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

/** Legacy ID for migration cross-reference */
export const oldId = () => bigint('old_id', { mode: 'number' });
