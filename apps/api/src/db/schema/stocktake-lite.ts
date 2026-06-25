import {
  pgTable,
  varchar,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { pk, companyId, auditTimestamps } from './common.js';

// ============================================================
// Stock-take-lite (P26) — the standalone iPad stock-take demo
// ------------------------------------------------------------
// DELIBERATELY DECOUPLED from the full count-vs-book stock-take
// (`stock_takes` / `stock_take_lines`): no FK to products, sites, the
// stock ledger or Xero. This is the low-friction "win the managers over"
// demo — a blank count seeded from the head-office spreadsheet, output as
// a plain CSV. The catalogue itself is bundled in the PWA (offline), so
// the server only ever stores what was counted.
//
// Multiple iPads count one site at once: each carries a client-generated
// `deviceId` + the counter's name. A device re-syncing the same item just
// updates its own row (idempotent on device+period+item). Consolidation is
// computed at read time — one counter per item ⇒ resolved; two or more ⇒
// CONFLICT (we never silently sum), cleared by a `stocktake_lite_resolutions`
// row before the item makes the CSV.
// ============================================================

export const stocktakeLiteCounts = pgTable(
  'stocktake_lite_counts',
  {
    id: pk(),
    companyId: companyId(),
    /** Stock-take event, e.g. 'JUNE-2026'. Groups a quarter's counts. */
    period: varchar('period', { length: 40 }).notNull(),
    /** Site slug aligned with the canonical sites (birmingham, liverpool, …). */
    siteSlug: varchar('site_slug', { length: 80 }).notNull(),
    /** Client-generated stable id for the iPad doing the counting. */
    deviceId: varchar('device_id', { length: 80 }).notNull(),
    counterName: varchar('counter_name', { length: 120 }).notNull(),
    /** Catalogue key for a seeded line, or `custom:<uuid>` for an added line. */
    itemKey: varchar('item_key', { length: 200 }).notNull(),
    itemName: varchar('item_name', { length: 300 }).notNull(),
    section: varchar('section', { length: 200 }),
    packSize: varchar('pack_size', { length: 200 }),
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    isCustom: boolean('is_custom').notNull().default(false),
    countedAt: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditTimestamps,
  },
  (t) => ({
    // A device counts each item at most once per period — re-sync upserts.
    stocktakeLiteCountsDeviceItemUnq: uniqueIndex('stocktake_lite_counts_device_item_unq').on(
      t.companyId,
      t.period,
      t.deviceId,
      t.itemKey,
    ),
    stocktakeLiteCountsSiteIdx: index('stocktake_lite_counts_site_idx').on(
      t.companyId,
      t.period,
      t.siteSlug,
    ),
  }),
);

export const stocktakeLiteResolutions = pgTable(
  'stocktake_lite_resolutions',
  {
    id: pk(),
    companyId: companyId(),
    period: varchar('period', { length: 40 }).notNull(),
    siteSlug: varchar('site_slug', { length: 80 }).notNull(),
    /** Group identity a conflict was resolved for (itemKey, or a name-based key
     *  for custom lines — see the service). */
    groupKey: varchar('group_key', { length: 300 }).notNull(),
    resolvedQty: numeric('resolved_qty', { precision: 18, scale: 3 }).notNull(),
    resolvedBy: varchar('resolved_by', { length: 120 }),
    ...auditTimestamps,
  },
  (t) => ({
    stocktakeLiteResolutionsUnq: uniqueIndex('stocktake_lite_resolutions_unq').on(
      t.companyId,
      t.period,
      t.siteSlug,
      t.groupKey,
    ),
  }),
);
