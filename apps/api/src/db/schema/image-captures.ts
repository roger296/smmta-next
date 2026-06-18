import {
  pgTable,
  varchar,
  uuid,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps, imageCaptureSourceEnum } from './common.js';
import { products } from './products.js';
import { sites } from './sites.js';

// ============================================================
// Image captures (spec §A10, P23) — AI groundwork, not a vision model
// ------------------------------------------------------------
// A labelled image set keyed by SKU (product) + site + timestamp, accumulated
// from product reference photos and the goods-in / stock-take / consumption
// capture flows. The stub MCP tools (identify_item_from_image,
// count_shelf_from_image) read this surface; a real model is a later, additive
// step. `product_id` / `site_id` are nullable — an un-attributed shelf photo
// has neither. Recording is best-effort and never blocks the capture workflow.
// ============================================================

export const imageCaptures = pgTable(
  'image_captures',
  {
    id: pk(),
    companyId: companyId(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    source: imageCaptureSourceEnum('source').notNull(),
    /** URL / object-store reference to the image. */
    imageRef: varchar('image_ref', { length: 1000 }).notNull(),
    label: varchar('label', { length: 200 }),
    /** The receipt / take / session id the capture came from, if any. */
    sourceRef: varchar('source_ref', { length: 200 }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditTimestamps,
  },
  (t) => ({
    imageCapturesSkuSiteIdx: index('image_captures_product_site_captured_idx').on(
      t.productId,
      t.siteId,
      t.capturedAt,
    ),
    imageCapturesRefIdx: index('image_captures_ref_idx').on(t.imageRef),
  }),
);

export const imageCapturesRelations = relations(imageCaptures, ({ one }) => ({
  product: one(products, { fields: [imageCaptures.productId], references: [products.id] }),
  site: one(sites, { fields: [imageCaptures.siteId], references: [sites.id] }),
}));
