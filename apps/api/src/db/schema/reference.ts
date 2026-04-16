import { pgTable, varchar, decimal, boolean, text, uuid } from 'drizzle-orm/pg-core';
import { pk, companyId, auditTimestamps, oldId } from './common.js';

// ============================================================
// Currencies
// ============================================================

export const currencies = pgTable('currencies', {
  id: pk(),
  code: varchar('code', { length: 3 }).notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  symbol: varchar('symbol', { length: 5 }),
  exchangeRateToBase: decimal('exchange_rate_to_base', { precision: 18, scale: 8 }).default('1'),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Warehouses
// ============================================================

export const warehouses = pgTable('warehouses', {
  id: pk(),
  companyId: companyId(),
  name: varchar('name', { length: 200 }).notNull(),
  addressLine1: varchar('address_line1', { length: 255 }),
  addressLine2: varchar('address_line2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  region: varchar('region', { length: 100 }),
  postCode: varchar('post_code', { length: 50 }),
  country: varchar('country', { length: 50 }),
  isDefault: boolean('is_default').notNull().default(false),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Categories
// ============================================================

export const categories = pgTable('categories', {
  id: pk(),
  companyId: companyId(),
  name: varchar('name', { length: 200 }).notNull(),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Manufacturers
// ============================================================

export const manufacturers = pgTable('manufacturers', {
  id: pk(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  logoUrl: varchar('logo_url', { length: 500 }),
  website: varchar('website', { length: 500 }),
  customerSupportPhone: varchar('customer_support_phone', { length: 50 }),
  customerSupportEmail: varchar('customer_support_email', { length: 100 }),
  techSupportPhone: varchar('tech_support_phone', { length: 50 }),
  techSupportEmail: varchar('tech_support_email', { length: 100 }),
  oldId: oldId(),
  ...auditTimestamps,
});
