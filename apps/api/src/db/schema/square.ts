import {
  pgTable,
  varchar,
  uuid,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps } from './common.js';
import { products } from './products.js';

// ============================================================
// Square integration (spec §A8) — sales → automatic stock decrement
// ============================================================

/** Square catalogue item / SKU → Auto-Stock product. Auto-suggested by
 *  barcode/ean where possible (`autoMatched`), else mapped by hand. */
export const squareItemMap = pgTable(
  'square_item_map',
  {
    id: pk(),
    companyId: companyId(),
    /** Square's catalogue object id or SKU. */
    squareKey: varchar('square_key', { length: 200 }).notNull(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    autoMatched: boolean('auto_matched').notNull().default(false),
    ...auditTimestamps,
  },
  (t) => ({
    squareItemMapCompanyKeyUnq: uniqueIndex('square_item_map_company_key_unq').on(
      t.companyId,
      t.squareKey,
    ),
  }),
);

/** Quarantine for sale lines whose Square item isn't mapped to a product (or
 *  whose site can't be resolved). Surfaced for the operator, never dropped.
 *  Unique on the order-line identity so replays don't pile up. */
export const squareUnmappedLines = pgTable(
  'square_unmapped_lines',
  {
    id: pk(),
    companyId: companyId(),
    channelSlug: varchar('channel_slug', { length: 60 }).notNull(),
    sourcePk: varchar('source_pk', { length: 200 }).notNull(),
    sourceLineRef: varchar('source_line_ref', { length: 200 }).notNull(),
    squareKey: varchar('square_key', { length: 200 }),
    siteRef: varchar('site_ref', { length: 200 }),
    qty: numeric('qty', { precision: 18, scale: 3 }).notNull(),
    reason: varchar('reason', { length: 60 }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (t) => ({
    squareUnmappedLineUnq: uniqueIndex('square_unmapped_line_unq').on(
      t.channelSlug,
      t.sourcePk,
      t.sourceLineRef,
    ),
    squareUnmappedResolvedIdx: index('square_unmapped_resolved_idx').on(t.resolvedAt),
  }),
);

export const squareItemMapRelations = relations(squareItemMap, ({ one }) => ({
  product: one(products, { fields: [squareItemMap.productId], references: [products.id] }),
}));
