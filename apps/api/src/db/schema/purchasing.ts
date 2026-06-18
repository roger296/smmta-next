import {
  pgTable, varchar, decimal, boolean, integer, text, uuid,
  doublePrecision, date as pgDate, timestamp, jsonb, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import {
  pk, companyId, auditTimestamps, oldId,
  vatTreatmentEnum, poDeliveryStatusEnum, poInvoiceStatusEnum,
  grnStatusEnum, supplierInvoiceStatusEnum, creditNoteStatusEnum,
  supplierAddressTypeEnum,
  supplierOrderStatusEnum, supplierConnectorKindEnum, supplierOrderChannelEnum,
} from './common.js';
import { products } from './products.js';
import { warehouses } from './reference.js';

// ============================================================
// Suppliers
// ============================================================

export const suppliers = pgTable('suppliers', {
  id: pk(),
  companyId: companyId(),
  name: varchar('name', { length: 200 }).notNull(),
  /** Stable URL-safe identifier, used by the drop-ship connector registry
   *  to look up which connector class to instantiate. Optional for
   *  pre-existing PO suppliers that don't drop-ship. */
  slug: varchar('slug', { length: 100 }),
  type: varchar('type', { length: 100 }),
  email: varchar('email', { length: 200 }),
  accountsEmail: varchar('accounts_email', { length: 200 }),
  website: varchar('website', { length: 500 }),
  currencyCode: varchar('currency_code', { length: 3 }).default('GBP'),
  creditLimit: decimal('credit_limit', { precision: 18, scale: 2 }).default('0'),
  creditTermDays: integer('credit_term_days').default(30),
  taxRatePercent: decimal('tax_rate_percent', { precision: 5, scale: 2 }).default('20'),
  vatTreatment: vatTreatmentEnum('vat_treatment').notNull().default('STANDARD_VAT_20'),
  vatRegistrationNumber: varchar('vat_registration_number', { length: 50 }),
  countryCode: varchar('country_code', { length: 3 }),
  leadTimeDays: integer('lead_time_days'),
  defaultExpenseAccountCode: varchar('default_expense_account_code', { length: 10 }),
  // ── Drop-ship integration ─────────────────────────────────────────
  /** Picks the connector class. NONE = no drop-ship integration (the
   *  existing PO-only suppliers). UNEEK = the Uneek Clothing API. STUB =
   *  in-test fixture. Add new connector kinds via this enum + registry. */
  connectorKind: supplierConnectorKindEnum('connector_kind').notNull().default('NONE'),
  apiBaseUrl: text('api_base_url'),
  /** AES-256-GCM ciphertext, formatted `<iv-hex>:<authTag-hex>:<ciphertext-hex>`.
   *  Decrypted at the service boundary; connectors only ever see plaintext. */
  apiKeyEnc: text('api_key_enc'),
  apiAuthScheme: varchar('api_auth_scheme', { length: 20 }).notNull().default('bearer'),
  isDropshipActive: boolean('is_dropship_active').notNull().default(false),
  pollIntervalMinutes: integer('poll_interval_minutes').notNull().default(180),
  dispatchSlaMinDays: integer('dispatch_sla_min_days').notNull().default(2),
  dispatchSlaMaxDays: integer('dispatch_sla_max_days').notNull().default(5),
  /** Published rate limit — what the supplier told us. The connector
   *  computes its inter-request delay from `(rate_limit_window_seconds
   *  * 1000 / rate_limit_requests) * SAFETY` so the operator never
   *  has to do the math. Both columns must be set together; either
   *  null means "no throttle from this pair". For Ralawise:
   *  `rate_limit_requests=10, rate_limit_window_seconds=60`. */
  rateLimitRequests: integer('rate_limit_requests'),
  rateLimitWindowSeconds: integer('rate_limit_window_seconds'),
  /** Escape hatch — explicit ms-between-requests value. Wins over the
   *  derived rate-limit pair when both are set. Useful for cases
   *  where the published limit and the real-world limit diverge.
   *  NULL = derive from rate_limit_* (or no throttle if those are null too). */
  minRequestIntervalMs: integer('min_request_interval_ms'),
  /** Surfaces in the admin SPA's supplier list when the most recent poll
   *  errored. Cleared on the next successful poll. */
  lastError: text('last_error'),
  /** Counts whole-supplier failures so the worker can self-disable a
   *  supplier after N consecutive failures (set isDropshipActive=false). */
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** When true, customer-facing emails name the supplier ("ships from
   *  Uneek Clothing"). Default false — the customer-facing copy reads
   *  "ships from our supplier partner". */
  showSupplierNameToCustomers: boolean('show_supplier_name_to_customers')
    .notNull()
    .default(false),
  // ── Auto-Stock ordering channel (spec §A7) ─────────────────────────
  /** EMAIL_PO (default) renders + emails a PO; API_CONNECTOR auto-places via
   *  the drop-ship connector. */
  orderChannel: supplierOrderChannelEnum('order_channel').notNull().default('EMAIL_PO'),
  /** Where emailed POs are sent (EMAIL_PO suppliers). Falls back to `email`. */
  orderEmail: varchar('order_email', { length: 200 }),
  /** Supplier-level default: auto-place reorders vs propose for approval. */
  autoPlace: boolean('auto_place').notNull().default(false),
  oldId: oldId(),
  ...auditTimestamps,
}, (t) => ({
  suppliersSlugUnq: uniqueIndex('suppliers_slug_unq').on(t.slug),
}));

// ============================================================
// Drop-ship: per-product supplier mapping
// ------------------------------------------------------------
// One row per (productId, supplierId) pair. Carries the supplier's
// SKU + cost price + the cached stock/price snapshot the polling
// worker writes on every run. See `apps/api/src/workers/supplier-poll.worker.ts`.
// ============================================================

export const supplierProducts = pgTable('supplier_products', {
  id: pk(),
  companyId: companyId(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  supplierSku: varchar('supplier_sku', { length: 200 }).notNull(),
  /** Manually-entered cost price, used as a fallback when the polling
   *  worker hasn't updated `lastKnownPrice` yet. */
  costGbp: decimal('cost_gbp', { precision: 12, scale: 2 }).notNull(),
  /** Most recent stock count from the supplier. NULL = never polled or
   *  the supplier didn't return this SKU. */
  lastKnownStock: integer('last_known_stock'),
  /** Most recent cost price returned by the supplier. NULL = price not
   *  returned. Updated alongside lastKnownStock on every poll. */
  lastKnownPrice: decimal('last_known_price', { precision: 12, scale: 2 }),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  lastPollError: text('last_poll_error'),
  isActive: boolean('is_active').notNull().default(true),
  /** Lower number wins when multiple suppliers carry the same SKU. */
  priority: integer('priority').notNull().default(100),
  // ── Auto-Stock (spec §A7) ──────────────────────────────────────────
  /** Per-item auto-place override. NULL = inherit the supplier's default;
   *  true/false overrides it for this specific mapping. */
  autoPlaceOverride: boolean('auto_place_override'),
  /** The supplier's buying unit + pack for this SKU (a brand may sell the
   *  fungible material in its own pack size, e.g. 2 kg bags). NULL ⇒ fall back
   *  to the product's purchase UoM. */
  supplierPurchaseUom: varchar('supplier_purchase_uom', { length: 20 }),
  supplierPackSize: decimal('supplier_pack_size', { precision: 18, scale: 3 }),
  ...auditTimestamps,
}, (t) => ({
  supplierProductsProductSupplierUnq: uniqueIndex('supplier_products_product_supplier_unq')
    .on(t.productId, t.supplierId),
}));

// ============================================================
// Drop-ship: outbound supplier orders (audit + idempotency)
// ------------------------------------------------------------
// Mirrors the gl_posting_log shape: every outbound call to a
// supplier's order API gets one row, identified by an idempotency
// key that lets us safely retry without double-placing.
// ============================================================

export const supplierOrders = pgTable('supplier_orders', {
  id: pk(),
  companyId: companyId(),
  /** The customer order this drop-ship line came from. Link is loose —
   *  we don't enforce the FK to keep this table independent of the
   *  customer-orders module's lifecycle. */
  customerOrderId: uuid('customer_order_id').notNull(),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  /** Deterministic per `(customerOrderId, supplierId, lineId)` —
   *  see §D's `pickSupplierForProduct`. Replays of the same payment
   *  webhook never produce duplicate supplier orders. */
  idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull().unique(),
  requestPayload: jsonb('request_payload'),
  supplierOrderRef: varchar('supplier_order_ref', { length: 200 }),
  status: supplierOrderStatusEnum('status').notNull().default('PENDING'),
  responsePayload: jsonb('response_payload'),
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').notNull().default(0),
  /** Set by the placer worker on a transient failure — the worker
   *  skips rows whose nextRetryAt is in the future. */
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
  trackingCarrier: varchar('tracking_carrier', { length: 100 }),
  trackingNumber: varchar('tracking_number', { length: 200 }),
  ...auditTimestamps,
});

// ============================================================
// Drop-ship: polling worker observability
// ------------------------------------------------------------
// One row per polling-worker run per supplier. The admin SPA reads
// this table to render success-rate / last-poll info.
// ============================================================

export const supplierPollLog = pgTable('supplier_poll_log', {
  id: pk(),
  companyId: companyId(),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  productsChecked: integer('products_checked').notNull().default(0),
  productsUpdated: integer('products_updated').notNull().default(0),
  errorMessage: text('error_message'),
});

// ============================================================
// Supplier Contacts
// ============================================================

export const supplierContacts = pgTable('supplier_contacts', {
  id: pk(),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  name: varchar('name', { length: 200 }),
  jobTitle: varchar('job_title', { length: 100 }),
  phone: varchar('phone', { length: 100 }),
  extension: varchar('extension', { length: 20 }),
  mobile: varchar('mobile', { length: 50 }),
  email: varchar('email', { length: 100 }),
  skype: varchar('skype', { length: 100 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Supplier Addresses
// ============================================================

export const supplierAddresses = pgTable('supplier_addresses', {
  id: pk(),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  contactName: varchar('contact_name', { length: 100 }),
  line1: varchar('line1', { length: 255 }),
  line2: varchar('line2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  region: varchar('region', { length: 100 }),
  postCode: varchar('post_code', { length: 50 }),
  country: varchar('country', { length: 50 }),
  addressType: supplierAddressTypeEnum('address_type').notNull().default('INVOICE'),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Purchase Orders
// ============================================================

export const purchaseOrders = pgTable('purchase_orders', {
  id: pk(),
  companyId: companyId(),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  contactId: uuid('contact_id').references(() => supplierContacts.id),
  addressId: uuid('address_id').references(() => supplierAddresses.id),
  deliveryWarehouseId: uuid('delivery_warehouse_id').references(() => warehouses.id),
  currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
  poNumber: varchar('po_number', { length: 100 }).notNull(),
  deliveryCharge: decimal('delivery_charge', { precision: 18, scale: 2 }).default('0'),
  lineTotal: decimal('line_total', { precision: 18, scale: 2 }).default('0'),
  taxTotal: decimal('tax_total', { precision: 18, scale: 2 }).default('0'),
  grandTotal: decimal('grand_total', { precision: 18, scale: 2 }).default('0'),
  deliveryStatus: poDeliveryStatusEnum('delivery_status').notNull().default('PENDING'),
  invoicedStatus: poInvoiceStatusEnum('invoiced_status').notNull().default('NOT_INVOICED'),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }).default('1'),
  vatTreatment: vatTreatmentEnum('vat_treatment').notNull().default('STANDARD_VAT_20'),
  expectedDeliveryDate: pgDate('expected_delivery_date'),
  trackingNumber: varchar('tracking_number', { length: 200 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Purchase Order Lines
// ============================================================

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: pk(),
  purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity: doublePrecision('quantity').notNull(),
  pricePerUnit: decimal('price_per_unit', { precision: 18, scale: 2 }).notNull(),
  taxName: varchar('tax_name', { length: 150 }),
  taxRate: doublePrecision('tax_rate').default(0),
  taxValue: decimal('tax_value', { precision: 18, scale: 2 }).default('0'),
  lineTotal: decimal('line_total', { precision: 18, scale: 2 }).notNull(),
  qtyBookedIn: doublePrecision('qty_booked_in').default(0),
  qtyInvoiced: doublePrecision('qty_invoiced').default(0),
  deliveryStatus: poDeliveryStatusEnum('delivery_status').notNull().default('PENDING'),
  accountCode: varchar('account_code', { length: 10 }),
  expectedDeliveryDate: pgDate('expected_delivery_date'),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Goods Received Notes
// ============================================================

export const goodsReceivedNotes = pgTable('goods_received_notes', {
  id: pk(),
  companyId: companyId(),
  purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id),
  grnNumber: varchar('grn_number', { length: 100 }),
  dateBookedIn: pgDate('date_booked_in').notNull(),
  supplierDeliveryNoteNo: varchar('supplier_delivery_note_no', { length: 100 }),
  status: grnStatusEnum('status').notNull().default('COMPLETED'),
  supportingDocUrl: varchar('supporting_doc_url', { length: 500 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// GRN Lines
// ============================================================

export const grnLines = pgTable('grn_lines', {
  id: pk(),
  grnId: uuid('grn_id').notNull().references(() => goodsReceivedNotes.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity: doublePrecision('quantity').notNull(),
  qtyBookedIn: doublePrecision('qty_booked_in').notNull(),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Supplier Invoices
// ============================================================

export const supplierInvoices = pgTable('supplier_invoices', {
  id: pk(),
  companyId: companyId(),
  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  contactId: uuid('contact_id').references(() => supplierContacts.id),
  addressId: uuid('address_id').references(() => supplierAddresses.id),
  currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
  invoiceNumber: varchar('invoice_number', { length: 100 }),
  deliveryCharge: decimal('delivery_charge', { precision: 18, scale: 2 }).default('0'),
  lineTotal: decimal('line_total', { precision: 18, scale: 2 }).default('0'),
  taxTotal: decimal('tax_total', { precision: 18, scale: 2 }).default('0'),
  grandTotal: decimal('grand_total', { precision: 18, scale: 2 }).notNull(),
  amountOutstanding: decimal('amount_outstanding', { precision: 18, scale: 2 }).notNull(),
  status: supplierInvoiceStatusEnum('status').notNull().default('DRAFT'),
  vatTreatment: vatTreatmentEnum('vat_treatment').notNull().default('STANDARD_VAT_20'),
  dateOfInvoice: pgDate('date_of_invoice').notNull(),
  dueDateOfInvoice: pgDate('due_date_of_invoice'),
  pdfUrl: varchar('pdf_url', { length: 500 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Supplier Credit Notes
// ============================================================

export const supplierCreditNotes = pgTable('supplier_credit_notes', {
  id: pk(),
  companyId: companyId(),
  supplierInvoiceId: uuid('supplier_invoice_id').references(() => supplierInvoices.id),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  contactId: uuid('contact_id').references(() => supplierContacts.id),
  addressId: uuid('address_id').references(() => supplierAddresses.id),
  currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
  creditNoteNumber: varchar('credit_note_number', { length: 100 }),
  deliveryCharge: decimal('delivery_charge', { precision: 18, scale: 2 }).default('0'),
  lineTotal: decimal('line_total', { precision: 18, scale: 2 }).default('0'),
  taxTotal: decimal('tax_total', { precision: 18, scale: 2 }).default('0'),
  creditNoteTotal: decimal('credit_note_total', { precision: 18, scale: 2 }).notNull(),
  amountOutstanding: decimal('amount_outstanding', { precision: 18, scale: 2 }).notNull(),
  status: creditNoteStatusEnum('status').notNull().default('DRAFT'),
  vatTreatment: vatTreatmentEnum('vat_treatment').notNull().default('STANDARD_VAT_20'),
  dateOfCreditNote: pgDate('date_of_credit_note').notNull(),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Supplier Notes
// ============================================================

export const supplierNotes = pgTable('supplier_notes', {
  id: pk(),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
  note: text('note').notNull(),
  userId: uuid('user_id'),
  attachmentUrl: varchar('attachment_url', { length: 500 }),
  isMarked: boolean('is_marked').notNull().default(false),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Relations
// ============================================================

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  contacts: many(supplierContacts),
  addresses: many(supplierAddresses),
  purchaseOrders: many(purchaseOrders),
  invoices: many(supplierInvoices),
  notes: many(supplierNotes),
  productMappings: many(supplierProducts),
  dropshipOrders: many(supplierOrders),
  pollLog: many(supplierPollLog),
}));

export const supplierProductsRelations = relations(supplierProducts, ({ one }) => ({
  product: one(products, { fields: [supplierProducts.productId], references: [products.id] }),
  supplier: one(suppliers, { fields: [supplierProducts.supplierId], references: [suppliers.id] }),
}));

export const supplierOrdersRelations = relations(supplierOrders, ({ one }) => ({
  supplier: one(suppliers, { fields: [supplierOrders.supplierId], references: [suppliers.id] }),
}));

export const supplierPollLogRelations = relations(supplierPollLog, ({ one }) => ({
  supplier: one(suppliers, { fields: [supplierPollLog.supplierId], references: [suppliers.id] }),
}));

export const supplierContactsRelations = relations(supplierContacts, ({ one }) => ({
  supplier: one(suppliers, { fields: [supplierContacts.supplierId], references: [suppliers.id] }),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [purchaseOrders.supplierId], references: [suppliers.id] }),
  contact: one(supplierContacts, { fields: [purchaseOrders.contactId], references: [supplierContacts.id] }),
  warehouse: one(warehouses, { fields: [purchaseOrders.deliveryWarehouseId], references: [warehouses.id] }),
  lines: many(purchaseOrderLines),
  grns: many(goodsReceivedNotes),
  invoices: many(supplierInvoices),
}));

export const purchaseOrderLinesRelations = relations(purchaseOrderLines, ({ one }) => ({
  purchaseOrder: one(purchaseOrders, { fields: [purchaseOrderLines.purchaseOrderId], references: [purchaseOrders.id] }),
  product: one(products, { fields: [purchaseOrderLines.productId], references: [products.id] }),
}));

export const goodsReceivedNotesRelations = relations(goodsReceivedNotes, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrders, { fields: [goodsReceivedNotes.purchaseOrderId], references: [purchaseOrders.id] }),
  lines: many(grnLines),
}));

export const supplierInvoicesRelations = relations(supplierInvoices, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrders, { fields: [supplierInvoices.purchaseOrderId], references: [purchaseOrders.id] }),
  supplier: one(suppliers, { fields: [supplierInvoices.supplierId], references: [suppliers.id] }),
  creditNotes: many(supplierCreditNotes),
}));

export const supplierCreditNotesRelations = relations(supplierCreditNotes, ({ one }) => ({
  supplierInvoice: one(supplierInvoices, { fields: [supplierCreditNotes.supplierInvoiceId], references: [supplierInvoices.id] }),
  supplier: one(suppliers, { fields: [supplierCreditNotes.supplierId], references: [suppliers.id] }),
}));

export const supplierAddressesRelations = relations(supplierAddresses, ({ one }) => ({
  supplier: one(suppliers, { fields: [supplierAddresses.supplierId], references: [suppliers.id] }),
}));

export const supplierNotesRelations = relations(supplierNotes, ({ one }) => ({
  supplier: one(suppliers, { fields: [supplierNotes.supplierId], references: [suppliers.id] }),
}));

export const grnLinesRelations = relations(grnLines, ({ one }) => ({
  grn: one(goodsReceivedNotes, { fields: [grnLines.grnId], references: [goodsReceivedNotes.id] }),
  product: one(products, { fields: [grnLines.productId], references: [products.id] }),
}));
