import {
  pgTable, varchar, decimal, boolean, integer, text, uuid,
  jsonb, doublePrecision, date as pgDate,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import {
  pk, companyId, auditTimestamps, oldId,
  orderStatusEnum, sourceChannelEnum, invoiceStatusEnum,
  creditNoteStatusEnum, allocationItemTypeEnum, vatTreatmentEnum,
} from './common.js';
import { customers, customerContacts, customerDeliveryAddresses, customerInvoiceAddresses } from './customers.js';
import { products } from './products.js';
import { warehouses } from './reference.js';

// ============================================================
// Custom Order Statuses
// ============================================================

export const customOrderStatuses = pgTable('custom_order_statuses', {
  id: pk(),
  companyId: companyId(),
  name: varchar('name', { length: 100 }).notNull(),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Customer Orders
// ============================================================

export const customerOrders = pgTable('customer_orders', {
  id: pk(),
  companyId: companyId(),
  orderNumber: varchar('order_number', { length: 100 }).notNull(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  contactId: uuid('contact_id').references(() => customerContacts.id),
  invoiceAddressId: uuid('invoice_address_id').references(() => customerInvoiceAddresses.id),
  deliveryAddressId: uuid('delivery_address_id').references(() => customerDeliveryAddresses.id),
  warehouseId: uuid('warehouse_id').references(() => warehouses.id),
  currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
  deliveryCharge: decimal('delivery_charge', { precision: 18, scale: 2 }).default('0'),
  orderTotal: decimal('order_total', { precision: 18, scale: 2 }).default('0'),
  taxTotal: decimal('tax_total', { precision: 18, scale: 2 }).default('0'),
  grandTotal: decimal('grand_total', { precision: 18, scale: 2 }).default('0'),
  status: orderStatusEnum('status').notNull().default('DRAFT'),
  customStatusId: uuid('custom_status_id').references(() => customOrderStatuses.id),
  paymentMethod: varchar('payment_method', { length: 100 }),
  orderDate: pgDate('order_date').notNull(),
  deliveryDate: pgDate('delivery_date'),
  shippedDate: pgDate('shipped_date'),
  taxInclusive: boolean('tax_inclusive').notNull().default(false),
  vatTreatment: vatTreatmentEnum('vat_treatment').notNull().default('STANDARD_VAT_20'),
  sourceChannel: sourceChannelEnum('source_channel').notNull().default('MANUAL'),
  integrationMetadata: jsonb('integration_metadata'),
  trackingNumber: varchar('tracking_number', { length: 200 }),
  trackingLink: varchar('tracking_link', { length: 500 }),
  courierName: varchar('courier_name', { length: 100 }),
  revenue: decimal('revenue', { precision: 18, scale: 2 }).default('0'),
  cogs: decimal('cogs', { precision: 18, scale: 2 }).default('0'),
  margin: decimal('margin', { precision: 18, scale: 2 }).default('0'),
  thirdPartyOrderId: varchar('third_party_order_id', { length: 100 }),
  customerOrderNumber: varchar('customer_order_number', { length: 100 }),
  factoryOrderNumber: varchar('factory_order_number', { length: 100 }),
  isProblemOrder: boolean('is_problem_order').notNull().default(false),
  problemType: varchar('problem_type', { length: 50 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Order Lines
// ============================================================

export const orderLines = pgTable('order_lines', {
  id: pk(),
  orderId: uuid('order_id').notNull().references(() => customerOrders.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity: doublePrecision('quantity').notNull(),
  pricePerUnit: decimal('price_per_unit', { precision: 18, scale: 2 }).notNull(),
  taxName: varchar('tax_name', { length: 150 }),
  taxRate: doublePrecision('tax_rate').default(0),
  taxValue: decimal('tax_value', { precision: 18, scale: 2 }).default('0'),
  lineTotal: decimal('line_total', { precision: 18, scale: 2 }).notNull(),
  numberShipped: doublePrecision('number_shipped').default(0),
  remainingQuantity: integer('remaining_quantity').default(0),
  thirdPartyProductId: varchar('third_party_product_id', { length: 100 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Invoices
// ============================================================

export const invoices = pgTable('invoices', {
  id: pk(),
  companyId: companyId(),
  orderId: uuid('order_id').references(() => customerOrders.id),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  contactId: uuid('contact_id').references(() => customerContacts.id),
  invoiceAddressId: uuid('invoice_address_id').references(() => customerInvoiceAddresses.id),
  deliveryAddressId: uuid('delivery_address_id').references(() => customerDeliveryAddresses.id),
  currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
  invoiceNumber: varchar('invoice_number', { length: 50 }),
  deliveryCharge: decimal('delivery_charge', { precision: 18, scale: 2 }).default('0'),
  lineTotal: decimal('line_total', { precision: 18, scale: 2 }).default('0'),
  taxTotal: decimal('tax_total', { precision: 18, scale: 2 }).default('0'),
  grandTotal: decimal('grand_total', { precision: 18, scale: 2 }).notNull(),
  amountOutstanding: decimal('amount_outstanding', { precision: 18, scale: 2 }).notNull(),
  status: invoiceStatusEnum('status').notNull().default('DRAFT'),
  vatTreatment: vatTreatmentEnum('vat_treatment').notNull().default('STANDARD_VAT_20'),
  dateOfInvoice: pgDate('date_of_invoice').notNull(),
  dueDateOfInvoice: pgDate('due_date_of_invoice'),
  pdfUrl: varchar('pdf_url', { length: 500 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Invoice Lines
// ============================================================

export const invoiceLines = pgTable('invoice_lines', {
  id: pk(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity: doublePrecision('quantity').notNull(),
  pricePerUnit: decimal('price_per_unit', { precision: 18, scale: 2 }).notNull(),
  taxName: varchar('tax_name', { length: 100 }),
  taxRate: doublePrecision('tax_rate').default(0),
  taxValue: decimal('tax_value', { precision: 18, scale: 2 }).default('0'),
  lineTotal: decimal('line_total', { precision: 18, scale: 2 }).notNull(),
  returnQty: doublePrecision('return_qty').default(0),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Credit Notes
// ============================================================

export const creditNotes = pgTable('credit_notes', {
  id: pk(),
  companyId: companyId(),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  contactId: uuid('contact_id').references(() => customerContacts.id),
  addressId: uuid('address_id').references(() => customerInvoiceAddresses.id),
  currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
  creditNoteNumber: varchar('credit_note_number', { length: 50 }),
  deliveryCharge: decimal('delivery_charge', { precision: 18, scale: 2 }).default('0'),
  lineTotal: decimal('line_total', { precision: 18, scale: 2 }).default('0'),
  taxTotal: decimal('tax_total', { precision: 18, scale: 2 }).default('0'),
  creditNoteTotal: decimal('credit_note_total', { precision: 18, scale: 2 }).notNull(),
  amountOutstanding: decimal('amount_outstanding', { precision: 18, scale: 2 }).notNull(),
  status: creditNoteStatusEnum('status').notNull().default('DRAFT'),
  vatTreatment: vatTreatmentEnum('vat_treatment').notNull().default('STANDARD_VAT_20'),
  dateOfCreditNote: pgDate('date_of_credit_note').notNull(),
  pdfUrl: varchar('pdf_url', { length: 500 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Credit Note Lines
// ============================================================

export const creditNoteLines = pgTable('credit_note_lines', {
  id: pk(),
  creditNoteId: uuid('credit_note_id').notNull().references(() => creditNotes.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  description: text('description'),
  quantity: doublePrecision('quantity').notNull(),
  pricePerUnit: decimal('price_per_unit', { precision: 18, scale: 2 }).notNull(),
  taxRate: doublePrecision('tax_rate').default(0),
  taxValue: decimal('tax_value', { precision: 18, scale: 2 }).default('0'),
  lineTotal: decimal('line_total', { precision: 18, scale: 2 }).notNull(),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Allocations (payment/credit note matching)
// ============================================================

export const allocations = pgTable('allocations', {
  id: pk(),
  companyId: companyId(),
  firstItemId: uuid('first_item_id').notNull(),
  firstItemType: allocationItemTypeEnum('first_item_type').notNull(),
  secondItemId: uuid('second_item_id').notNull(),
  secondItemType: allocationItemTypeEnum('second_item_type').notNull(),
  amount: decimal('amount', { precision: 18, scale: 2 }).notNull(),
  allocationDate: pgDate('allocation_date').notNull(),
  voided: boolean('voided').notNull().default(false),
  createdBy: uuid('created_by'),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Order Notes
// ============================================================

export const orderNotes = pgTable('order_notes', {
  id: pk(),
  orderId: uuid('order_id').notNull().references(() => customerOrders.id),
  note: text('note').notNull(),
  userId: uuid('user_id'),
  attachmentUrl: varchar('attachment_url', { length: 500 }),
  isMarked: boolean('is_marked').notNull().default(false),
  isPickingNote: boolean('is_picking_note').notNull().default(false),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Relations
// ============================================================

export const customerOrdersRelations = relations(customerOrders, ({ one, many }) => ({
  customer: one(customers, { fields: [customerOrders.customerId], references: [customers.id] }),
  contact: one(customerContacts, { fields: [customerOrders.contactId], references: [customerContacts.id] }),
  invoiceAddress: one(customerInvoiceAddresses, { fields: [customerOrders.invoiceAddressId], references: [customerInvoiceAddresses.id] }),
  deliveryAddress: one(customerDeliveryAddresses, { fields: [customerOrders.deliveryAddressId], references: [customerDeliveryAddresses.id] }),
  warehouse: one(warehouses, { fields: [customerOrders.warehouseId], references: [warehouses.id] }),
  lines: many(orderLines),
  notes: many(orderNotes),
  invoices: many(invoices),
}));

export const orderLinesRelations = relations(orderLines, ({ one }) => ({
  order: one(customerOrders, { fields: [orderLines.orderId], references: [customerOrders.id] }),
  product: one(products, { fields: [orderLines.productId], references: [products.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  order: one(customerOrders, { fields: [invoices.orderId], references: [customerOrders.id] }),
  customer: one(customers, { fields: [invoices.customerId], references: [customers.id] }),
  lines: many(invoiceLines),
  creditNotes: many(creditNotes),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
  product: one(products, { fields: [invoiceLines.productId], references: [products.id] }),
}));

export const creditNotesRelations = relations(creditNotes, ({ one, many }) => ({
  invoice: one(invoices, { fields: [creditNotes.invoiceId], references: [invoices.id] }),
  customer: one(customers, { fields: [creditNotes.customerId], references: [customers.id] }),
  lines: many(creditNoteLines),
}));

export const creditNoteLinesRelations = relations(creditNoteLines, ({ one }) => ({
  creditNote: one(creditNotes, { fields: [creditNoteLines.creditNoteId], references: [creditNotes.id] }),
  product: one(products, { fields: [creditNoteLines.productId], references: [products.id] }),
}));

export const orderNotesRelations = relations(orderNotes, ({ one }) => ({
  order: one(customerOrders, { fields: [orderNotes.orderId], references: [customerOrders.id] }),
}));
