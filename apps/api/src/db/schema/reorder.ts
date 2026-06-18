import {
  pgTable,
  varchar,
  uuid,
  numeric,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import {
  pk,
  companyId,
  auditTimestamps,
  reorderProposalStatusEnum,
  supplierOrderChannelEnum,
} from './common.js';
import { products } from './products.js';
import { sites } from './sites.js';
import { suppliers } from './purchasing.js';

// ============================================================
// Reorder proposals (spec §A7) — the auto-reorder engine's record
// ------------------------------------------------------------
// One row per replenishment. Idempotent + retryable, mirroring the
// supplier_orders shape, but purpose-built for stock replenishment
// (no customer order / shipping address). Created when on-hand falls
// to the reorder point (on a decrement or the daily sweep); placed via
// the supplier connector (API_CONNECTOR) or rendered as an emailed PO
// (EMAIL_PO). auto_place=false proposals wait in PROPOSED for approval.
// ============================================================

export const reorderProposals = pgTable(
  'reorder_proposals',
  {
    id: pk(),
    companyId: companyId(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    /** Quantity to order, in the product's stock_uom and the supplier's
     *  purchase_uom (after pack-size rounding). */
    suggestedQtyStock: numeric('suggested_qty_stock', { precision: 18, scale: 3 }).notNull(),
    suggestedQtyPurchase: numeric('suggested_qty_purchase', { precision: 18, scale: 3 }),
    purchaseUom: varchar('purchase_uom', { length: 20 }),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
    status: reorderProposalStatusEnum('status').notNull().default('PROPOSED'),
    channel: supplierOrderChannelEnum('channel'),
    /** How it was raised: 'decrement' | 'sweep' | 'manual'. */
    triggeredBy: varchar('triggered_by', { length: 20 }).notNull().default('sweep'),
    /** Rendered emailed-PO document (EMAIL_PO channel). */
    renderedPo: jsonb('rendered_po'),
    supplierOrderRef: varchar('supplier_order_ref', { length: 200 }),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    placedAt: timestamp('placed_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (t) => ({
    reorderProposalsProductSiteIdx: index('reorder_proposals_product_site_idx').on(
      t.productId,
      t.siteId,
    ),
    reorderProposalsStatusIdx: index('reorder_proposals_status_idx').on(t.status),
  }),
);

export const reorderProposalsRelations = relations(reorderProposals, ({ one }) => ({
  product: one(products, { fields: [reorderProposals.productId], references: [products.id] }),
  site: one(sites, { fields: [reorderProposals.siteId], references: [sites.id] }),
  supplier: one(suppliers, { fields: [reorderProposals.supplierId], references: [suppliers.id] }),
}));
