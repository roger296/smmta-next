import {
  pgTable,
  varchar,
  uuid,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps } from './common.js';
import { products } from './products.js';
import { sites } from './sites.js';

// ============================================================
// Stock batches / lots (spec §A3, §9 Phase 3) — batch + use-by tracking
// ------------------------------------------------------------
// Optional per (product, site): only products with `require_batch_number`
// carry batches. A batch is created on goods-in and decremented FEFO
// (first-expiry-first-out) on consumption. `qty_remaining` is the live amount
// left in the lot (in stock_uom); `use_by` drives FEFO ordering + expiry
// reporting. The `stock_movements` ledger stays the source of truth for total
// on-hand; batches add the lot-level detail for food safety.
// ============================================================

export const stockBatches = pgTable(
  'stock_batches',
  {
    id: pk(),
    companyId: companyId(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    batchCode: varchar('batch_code', { length: 100 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** YYYY-MM-DD; NULL for a non-perishable lot (sorted last in FEFO). */
    useBy: date('use_by'),
    originalQty: numeric('original_qty', { precision: 18, scale: 3 }).notNull(),
    qtyRemaining: numeric('qty_remaining', { precision: 18, scale: 3 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
    ...auditTimestamps,
  },
  (t) => ({
    stockBatchesCodeUnq: uniqueIndex('stock_batches_company_product_site_code_unq').on(
      t.companyId,
      t.productId,
      t.siteId,
      t.batchCode,
    ),
    stockBatchesFefoIdx: index('stock_batches_fefo_idx').on(t.productId, t.siteId, t.useBy),
  }),
);

export const stockBatchesRelations = relations(stockBatches, ({ one }) => ({
  product: one(products, { fields: [stockBatches.productId], references: [products.id] }),
  site: one(sites, { fields: [stockBatches.siteId], references: [sites.id] }),
}));
