import {
  pgTable, varchar, decimal, boolean, integer, text, uuid,
  doublePrecision, date as pgDate,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import {
  pk, companyId, auditTimestamps, oldId,
  vatTreatmentEnum, poDeliveryStatusEnum, poInvoiceStatusEnum,
  grnStatusEnum, supplierInvoiceStatusEnum, creditNoteStatusEnum,
  supplierAddressTypeEnum,
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
  oldId: oldId(),
  ...auditTimestamps,
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
