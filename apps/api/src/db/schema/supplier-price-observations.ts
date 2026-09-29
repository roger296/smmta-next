import {
  pgTable,
  pgEnum,
  varchar,
  uuid,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { pk, companyId } from './common.js';
import { suppliers, supplierProducts } from './purchasing.js';
import { sites } from './sites.js';

// ============================================================
// Supplier price observations (supplier-ordering groundwork, Sept 2026)
// ------------------------------------------------------------
// Every price we SEE for a buying option, append-only, with where it came from
// and when (docs/plans/SUPPLIER_ORDERING_PLAN.md §3.3). `supplier_products.
// cost_gbp` is one number with no date and no source, so a price imported in
// July looks exactly as current as one paid yesterday, and a bad OCR read
// overwrites a good one. Keeping the history makes staleness visible ("last
// paid 4 months ago"), makes a price move visible, and lets a single odd read
// be outvoted.
//
// `unit_price` is per ONE of what the supplier bills under that code — the
// mapping's own unit (a 25 kg sack, a case of 12), not the product's stock
// unit. Converting to a comparable cost per stock unit is the ranking's job,
// and needs the mapping's pack size.
// ============================================================

export const priceObservationSourceEnum = pgEnum('price_observation_source', [
  'INVOICE',
  'PO_CONFIRMED',
  'GOODS_IN',
  'QUOTE_API',
  'CATALOGUE_FILE',
  'MANUAL',
]);

export const supplierPriceObservations = pgTable(
  'supplier_price_observations',
  {
    id: pk(),
    companyId: companyId(),
    supplierProductId: uuid('supplier_product_id')
      .notNull()
      .references(() => supplierProducts.id, { onDelete: 'cascade' }),
    /** Denormalised from the mapping, for per-supplier reporting. */
    supplierId: uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'cascade' }),
    /** The venue the price was paid for, when known — prices can differ by depot. */
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    source: priceObservationSourceEnum('source').notNull(),
    unitPrice: numeric('unit_price', { precision: 18, scale: 6 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
    quantity: numeric('quantity', { precision: 18, scale: 3 }),
    /** The pack as printed on the document ("12x1L"), for a human to read. */
    packSeen: varchar('pack_seen', { length: 120 }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    /** The document it came from: an invoice number, a PO number. */
    documentRef: varchar('document_ref', { length: 120 }),
    /** Deterministic key from the source, so re-running an import is a no-op. */
    sourceKey: varchar('source_key', { length: 300 }),
    /** Anything a reader should know — e.g. the unit price was derived from the
     *  line total because the OCR'd unit price disagreed with it. */
    note: varchar('note', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    supplierPriceObsLatestIdx: index('supplier_price_obs_latest_idx').on(t.supplierProductId, t.observedAt),
    supplierPriceObsSourceKeyUnq: uniqueIndex('supplier_price_obs_source_key_unq')
      .on(t.companyId, t.source, t.sourceKey)
      .where(sql`source_key IS NOT NULL`),
  }),
);

export const supplierPriceObservationsRelations = relations(supplierPriceObservations, ({ one }) => ({
  supplierProduct: one(supplierProducts, {
    fields: [supplierPriceObservations.supplierProductId],
    references: [supplierProducts.id],
  }),
  supplier: one(suppliers, { fields: [supplierPriceObservations.supplierId], references: [suppliers.id] }),
  site: one(sites, { fields: [supplierPriceObservations.siteId], references: [sites.id] }),
}));
