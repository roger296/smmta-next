import { pgTable, varchar, decimal, boolean, text, uuid, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
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

export const categories = pgTable(
  'categories',
  {
    id: pk(),
    companyId: companyId(),
    name: varchar('name', { length: 200 }).notNull(),
    /** URL slug — kebab-case lowercase. Unique per `(parent_id, slug)`
     *  so `tops/t-shirts` and `kids-and-schoolwear/kids-tops` don't
     *  collide despite sharing a leaf name pattern. */
    slug: varchar('slug', { length: 100 }),
    /** Self-FK for the two-tier hierarchy. Top-tier categories have
     *  `parent_id = NULL`. Restrict on delete so an accidental delete
     *  of a parent doesn't orphan children. */
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
    /** SEO / landing-page copy. */
    description: text('description'),
    /** Lower numbers sort earlier within their parent. Defaults to 100
     *  so manual reorders (sort_order = 1..N) take precedence. */
    sortOrder: integer('sort_order').notNull().default(100),
    /** Hidden categories don't appear in the storefront nav. Used for
     *  the `uncategorised` fallback bucket. */
    isHidden: boolean('is_hidden').notNull().default(false),
    oldId: oldId(),
    ...auditTimestamps,
  },
  (t) => ({
    parentSlugUnq: uniqueIndex('categories_parent_slug_unq').on(t.parentId, t.slug),
  }),
);

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
