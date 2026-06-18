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

/**
 * Drop-shipping supplier-order lifecycle. PENDING → PLACED on a successful
 * outbound API call; ACKNOWLEDGED when the supplier confirms; SHIPPED /
 * DELIVERED for tracking; CANCELLED if we abort; FAILED after retry budget
 * is exhausted.
 */
export const supplierOrderStatusEnum = pgEnum('supplier_order_status', [
  'PENDING', 'PLACED', 'ACKNOWLEDGED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED',
]);

/** Discriminator for the connector module a supplier uses. */
export const supplierConnectorKindEnum = pgEnum('supplier_connector_kind', [
  'NONE', 'UNEEK', 'RALAWISE', 'STUB',
]);

/** Per-line fulfilment source, decided at checkout-start by the
 *  reservation service. WAREHOUSE = the existing reserve-from-stock
 *  flow. SUPPLIER = no warehouse reservation; a `supplier_orders` row
 *  is inserted on payment confirmation and the placer worker calls
 *  the supplier's order API. */
export const fulfilmentSourceEnum = pgEnum('fulfilment_source', [
  'WAREHOUSE', 'SUPPLIER',
]);

// ── Auto-Stock: multi-site stock (spec §A5) ──────────────────────────

/**
 * Item kind (spec §A3). MERCH + RETAIL are sold AND stocked; INGREDIENT +
 * PACKAGING are stocked but not sold (consumed by recipes / the head-baker
 * form). The `is_sold` / `is_stocked` flags carry the fine detail; this enum
 * is the headline classification.
 */
export const itemKindEnum = pgEnum('item_kind', [
  'MERCH', 'RETAIL', 'INGREDIENT', 'PACKAGING',
]);

/** Unit-of-measure system for a site. Drives display + count quanta
 *  (Dallas runs IMPERIAL / lb·oz; UK sites METRIC / g). */
export const uomSystemEnum = pgEnum('uom_system', ['METRIC', 'IMPERIAL']);

/**
 * Stock-movement ledger entry type. On-hand is the running sum of these
 * signed deltas, never a bare counter (spec §A5). GRN = goods received,
 * SALE = Square decrement, CONSUMPTION/WASTAGE = head-baker form,
 * TRANSFER_IN/OUT = inter-site moves (paired), STOCKTAKE_TRUE_UP = count
 * variance, OPENING = initial balance.
 */
export const stockMovementTypeEnum = pgEnum('stock_movement_type', [
  'GRN', 'ADJUSTMENT', 'SALE', 'CONSUMPTION', 'WASTAGE',
  'TRANSFER_IN', 'TRANSFER_OUT', 'STOCKTAKE_TRUE_UP', 'OPENING',
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
