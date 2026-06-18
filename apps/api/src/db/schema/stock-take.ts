import {
  pgTable,
  varchar,
  uuid,
  numeric,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import {
  pk,
  companyId,
  auditTimestamps,
  stockTakeScopeEnum,
  stockTakeStatusEnum,
} from './common.js';
import { products } from './products.js';
import { sites } from './sites.js';

// ============================================================
// Stock-takes (spec §A6) — count vs book, true-up the ledger
// ------------------------------------------------------------
// Opening a take snapshots book stock for the scope into lines; counts
// are recorded against lines (barcode/QR identified, offline-tolerant
// via a client idempotency key); approval writes a STOCKTAKE_TRUE_UP
// movement for each varianced line and posts one adjustment to Xero.
// ============================================================

export const stockTakes = pgTable(
  'stock_takes',
  {
    id: pk(),
    companyId: companyId(),
    siteId: uuid('site_id').notNull().references(() => sites.id),
    scope: stockTakeScopeEnum('scope').notNull().default('FULL'),
    /** Scope target: a category id (CATEGORY), product id (ITEM), or a free
     *  zone label (ZONE). NULL for FULL/CYCLE. */
    scopeRef: varchar('scope_ref', { length: 200 }),
    status: stockTakeStatusEnum('status').notNull().default('OPEN'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (t) => ({
    stockTakesSiteIdx: index('stock_takes_site_idx').on(t.siteId),
    stockTakesStatusIdx: index('stock_takes_status_idx').on(t.status),
  }),
);

export const stockTakeLines = pgTable(
  'stock_take_lines',
  {
    id: pk(),
    stockTakeId: uuid('stock_take_id').notNull().references(() => stockTakes.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull().references(() => products.id),
    /** Book on-hand snapshotted when the take opened (stock_uom). */
    bookQty: numeric('book_qty', { precision: 18, scale: 3 }).notNull(),
    /** Counted quantity (stock_uom); NULL until counted. */
    countedQty: numeric('counted_qty', { precision: 18, scale: 3 }),
    /** counted − book; NULL until counted. */
    variance: numeric('variance', { precision: 18, scale: 3 }),
    /** Offline idempotency — a re-submitted count batch carrying the same key
     *  doesn't double-apply. */
    countIdempotencyKey: varchar('count_idempotency_key', { length: 200 }),
    photoRefs: jsonb('photo_refs'),
    countedAt: timestamp('counted_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (t) => ({
    stockTakeLinesTakeProductUnq: uniqueIndex('stock_take_lines_take_product_unq').on(
      t.stockTakeId,
      t.productId,
    ),
  }),
);

export const stockTakesRelations = relations(stockTakes, ({ one, many }) => ({
  site: one(sites, { fields: [stockTakes.siteId], references: [sites.id] }),
  lines: many(stockTakeLines),
}));

export const stockTakeLinesRelations = relations(stockTakeLines, ({ one }) => ({
  take: one(stockTakes, { fields: [stockTakeLines.stockTakeId], references: [stockTakes.id] }),
  product: one(products, { fields: [stockTakeLines.productId], references: [products.id] }),
}));
