import { pgTable, varchar, decimal, boolean, integer, text, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps, oldId, vatTreatmentEnum } from './common.js';
import { currencies } from './reference.js';

// ============================================================
// Customer Types
// ============================================================

export const customerTypes = pgTable('customer_types', {
  id: pk(),
  companyId: companyId(),
  name: varchar('name', { length: 150 }).notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Customers
// ============================================================

export const customers = pgTable('customers', {
  id: pk(),
  companyId: companyId(),
  name: varchar('name', { length: 200 }).notNull(),
  shortName: varchar('short_name', { length: 50 }),
  typeId: uuid('type_id').references(() => customerTypes.id),
  email: varchar('email', { length: 100 }),
  creditLimit: decimal('credit_limit', { precision: 18, scale: 2 }).default('0'),
  creditCurrencyCode: varchar('credit_currency_code', { length: 3 }).default('GBP'),
  creditTermDays: integer('credit_term_days').default(30),
  taxRatePercent: decimal('tax_rate_percent', { precision: 5, scale: 2 }).default('20'),
  vatTreatment: vatTreatmentEnum('vat_treatment').notNull().default('STANDARD_VAT_20'),
  vatRegistrationNumber: varchar('vat_registration_number', { length: 50 }),
  companyRegistrationNumber: varchar('company_registration_number', { length: 50 }),
  countryCode: varchar('country_code', { length: 3 }),
  defaultRevenueAccountCode: varchar('default_revenue_account_code', { length: 10 }),
  warehouseId: uuid('warehouse_id'),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Customer Contacts
// ============================================================

export const customerContacts = pgTable('customer_contacts', {
  id: pk(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  name: varchar('name', { length: 200 }),
  jobTitle: varchar('job_title', { length: 100 }),
  officePhone: varchar('office_phone', { length: 100 }),
  extension: varchar('extension', { length: 20 }),
  mobile: varchar('mobile', { length: 50 }),
  email: varchar('email', { length: 100 }),
  skype: varchar('skype', { length: 100 }),
  twitter: varchar('twitter', { length: 100 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Customer Delivery Addresses
// ============================================================

export const customerDeliveryAddresses = pgTable('customer_delivery_addresses', {
  id: pk(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  contactName: varchar('contact_name', { length: 100 }),
  line1: varchar('line1', { length: 255 }),
  line2: varchar('line2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  region: varchar('region', { length: 100 }),
  postCode: varchar('post_code', { length: 50 }),
  country: varchar('country', { length: 50 }),
  isDefault: boolean('is_default').notNull().default(false),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Customer Invoice Addresses
// ============================================================

export const customerInvoiceAddresses = pgTable('customer_invoice_addresses', {
  id: pk(),
  customerId: uuid('customer_id').references(() => customers.id),
  contactName: varchar('contact_name', { length: 100 }),
  line1: varchar('line1', { length: 255 }),
  line2: varchar('line2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  region: varchar('region', { length: 100 }),
  postCode: varchar('post_code', { length: 50 }),
  country: varchar('country', { length: 50 }),
  invoiceText: text('invoice_text'),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Customer Notes
// ============================================================

export const customerNotes = pgTable('customer_notes', {
  id: pk(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  note: text('note').notNull(),
  userId: uuid('user_id'),
  attachmentUrl: varchar('attachment_url', { length: 500 }),
  isMarked: boolean('is_marked').notNull().default(false),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Customer Product Prices
// ============================================================

export const customerProductPrices = pgTable('customer_product_prices', {
  id: pk(),
  companyId: companyId(),
  customerId: uuid('customer_id').notNull(),
  productId: uuid('product_id').notNull(),
  price: decimal('price', { precision: 18, scale: 2 }).notNull(),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Relations
// ============================================================

export const customersRelations = relations(customers, ({ one, many }) => ({
  type: one(customerTypes, { fields: [customers.typeId], references: [customerTypes.id] }),
  contacts: many(customerContacts),
  deliveryAddresses: many(customerDeliveryAddresses),
  invoiceAddresses: many(customerInvoiceAddresses),
  notes: many(customerNotes),
  productPrices: many(customerProductPrices),
}));

export const customerContactsRelations = relations(customerContacts, ({ one }) => ({
  customer: one(customers, { fields: [customerContacts.customerId], references: [customers.id] }),
}));

export const customerDeliveryAddressesRelations = relations(customerDeliveryAddresses, ({ one }) => ({
  customer: one(customers, { fields: [customerDeliveryAddresses.customerId], references: [customers.id] }),
}));

export const customerInvoiceAddressesRelations = relations(customerInvoiceAddresses, ({ one }) => ({
  customer: one(customers, { fields: [customerInvoiceAddresses.customerId], references: [customers.id] }),
}));

export const customerNotesRelations = relations(customerNotes, ({ one }) => ({
  customer: one(customers, { fields: [customerNotes.customerId], references: [customers.id] }),
}));
