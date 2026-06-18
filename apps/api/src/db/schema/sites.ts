import {
  pgTable,
  varchar,
  uuid,
  boolean,
  integer,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import {
  pk,
  companyId,
  auditTimestamps,
  uomSystemEnum,
  stockMovementTypeEnum,
} from './common.js';
import { products } from './products.js';

// ============================================================
// Sites (multi-location) — spec §A5
// ------------------------------------------------------------
// First-class locations. Slugs align with BumbleBee's canonical sites
// (birmingham, liverpool, london-east, london-south, manchester, + a
// future dallas). `canonicalName` stores the BumbleBee display string
// so cross-system joins (sessions, orders) line up. Currency + UoM
// system live on the row from day one so adding a USD/imperial site
// (Dallas, P20) is one admin action with no code change.
// ============================================================

export const sites = pgTable(
  'sites',
  {
    id: pk(),
    companyId: companyId(),
    slug: varchar('slug', { length: 80 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    /** BumbleBee canonical display string (e.g. "London East") for joins. */
    canonicalName: varchar('canonical_name', { length: 200 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
    uomSystem: uomSystemEnum('uom_system').notNull().default('METRIC'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Europe/London'),
    isActive: boolean('is_active').notNull().default(true),
    ...auditTimestamps,
  },
  (t) => ({
    sitesCompanySlugUnq: uniqueIndex('sites_company_slug_unq').on(t.companyId, t.slug),
  }),
);

// ============================================================
// Stock levels — per (product, site)
// ------------------------------------------------------------
// `onHand` is a denormalised cache of the running sum of the
// stock_movements ledger for the pair; StockLevelService keeps the two
// in lock-step inside one transaction, and recomputeOnHand() can
// re-derive it from the ledger (repair / tests). Quantities are in the
// product's `stock_uom`. Reorder params (point / up-to / min-days-cover)
// live here, per site (spec §A7).
// ============================================================

export const stockLevels = pgTable(
  'stock_levels',
  {
    id: pk(),
    companyId: companyId(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    onHand: numeric('on_hand', { precision: 18, scale: 3 }).notNull().default('0'),
    allocated: numeric('allocated', { precision: 18, scale: 3 }).notNull().default('0'),
    reorderPoint: numeric('reorder_point', { precision: 18, scale: 3 }),
    reorderUpTo: numeric('reorder_up_to', { precision: 18, scale: 3 }),
    minDaysCover: integer('min_days_cover'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stockLevelsProductSiteUnq: uniqueIndex('stock_levels_company_product_site_unq').on(
      t.companyId,
      t.productId,
      t.siteId,
    ),
    stockLevelsSiteIdx: index('stock_levels_site_idx').on(t.siteId),
  }),
);

// ============================================================
// Stock movements — the auditable ledger
// ------------------------------------------------------------
// Append-only. `qtyDelta` is signed (in stock_uom). Idempotency mirrors
// the gl_posting_log / order-build convention: a unique
// (source_system, source_key, content_hash) means a re-applied movement
// (replayed Square sale, re-run sweep) is a no-op.
// ============================================================

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: pk(),
    companyId: companyId(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    qtyDelta: numeric('qty_delta', { precision: 18, scale: 3 }).notNull(),
    movementType: stockMovementTypeEnum('movement_type').notNull(),
    sourceSystem: varchar('source_system', { length: 60 }).notNull(),
    sourceKey: varchar('source_key', { length: 200 }).notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    /** Cost per stock_uom at the time of the movement (nullable — e.g. a
     *  stocktake true-up carries no fresh cost). Used for valuation. */
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stockMovementsSourceUnq: uniqueIndex('stock_movements_source_unq').on(
      t.sourceSystem,
      t.sourceKey,
      t.contentHash,
    ),
    stockMovementsProductSiteIdx: index('stock_movements_product_site_idx').on(
      t.productId,
      t.siteId,
    ),
    stockMovementsOccurredIdx: index('stock_movements_occurred_idx').on(t.occurredAt),
  }),
);

// ── Relations ────────────────────────────────────────────────────────

export const sitesRelations = relations(sites, ({ many }) => ({
  stockLevels: many(stockLevels),
  stockMovements: many(stockMovements),
}));

export const stockLevelsRelations = relations(stockLevels, ({ one }) => ({
  site: one(sites, { fields: [stockLevels.siteId], references: [sites.id] }),
  product: one(products, { fields: [stockLevels.productId], references: [products.id] }),
}));

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  site: one(sites, { fields: [stockMovements.siteId], references: [sites.id] }),
  product: one(products, { fields: [stockMovements.productId], references: [products.id] }),
}));
