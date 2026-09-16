import { pgTable, varchar, integer, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps } from './common.js';
import { products } from './products.js';

// ============================================================
// Item categories (Sept-2026 request)
// ------------------------------------------------------------
// The operator's own classification of a stocked item — "Dry Stock",
// "Bar", "Packaging", "Cleaning". Behaves as an enum on the product
// (one value, chosen from a list) but is a TABLE, because the request
// is that head office can add a category from the UI and a Postgres
// enum needs a migration to extend.
//
// Kept separate from `categories`, which is the storefront taxonomy AND
// the stock-take sheet's area/section structure — rule-assigned and
// many-to-many respectively. See migration 0050 for the full reasoning.
// ============================================================

export const itemCategories = pgTable(
  'item_categories',
  {
    id: pk(),
    companyId: companyId(),
    name: varchar('name', { length: 100 }).notNull(),
    /** Display order in the picker; ties break on name. */
    sortOrder: integer('sort_order').notNull().default(0),
    ...auditTimestamps,
  },
  (t) => ({
    itemCategoriesCompanyIdx: index('item_categories_company_idx').on(t.companyId),
  }),
);

export const itemCategoriesRelations = relations(itemCategories, ({ many }) => ({
  products: many(products),
}));
