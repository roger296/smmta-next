import {
  pgTable,
  varchar,
  uuid,
  numeric,
  integer,
  date,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps } from './common.js';
import { products } from './products.js';
import { sites } from './sites.js';

// ============================================================
// Session consumption (spec §A6) — the head-baker end-of-session form
// ------------------------------------------------------------
// One record per BumbleBee session: the baker (chosen at submit) confirms
// the actual ingredient usage + wastage, which decrements site stock
// (CONSUMPTION + WASTAGE movements) and records variance vs the expected
// (recipe × covers). Amendable within a window — re-submitting the same
// session amends the one record (version bumped) and posts the corrective
// stock deltas, never a duplicate. `client_key` makes an offline replay a
// no-op. `materials_cost` (actual qty × unit cost) feeds P17.
// ============================================================

export const sessionConsumption = pgTable(
  'session_consumption',
  {
    id: pk(),
    companyId: companyId(),
    siteId: uuid('site_id').notNull().references(() => sites.id),
    /** BumbleBee session id — the natural key (one record per session). */
    sessionId: varchar('session_id', { length: 200 }).notNull(),
    sessionDate: date('session_date').notNull(),
    /** Baker identity chosen at submit (from the site roster / Deputy). */
    bakerName: varchar('baker_name', { length: 200 }).notNull(),
    bakerRef: varchar('baker_ref', { length: 200 }),
    /** Total covers across the session's experiences — for per-cover food-cost
     *  metrics (P18). Σ of the submitted cover-groups. */
    covers: integer('covers').notNull().default(0),
    /** Bumped on each amend; drives the per-version movement idempotency key. */
    version: integer('version').notNull().default(0),
    /** Last offline idempotency key applied — a replay with the same key is a
     *  no-op (doesn't bump the version or re-post movements). */
    clientKey: varchar('client_key', { length: 200 }),
    /** Σ(actual qty × unit cost) — the true materials cost of the session. */
    materialsCost: numeric('materials_cost', { precision: 18, scale: 2 }).notNull().default('0'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
    notes: text('notes'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (t) => ({
    sessionConsumptionSessionUnq: uniqueIndex('session_consumption_company_session_unq').on(
      t.companyId,
      t.sessionId,
    ),
    sessionConsumptionSiteDateIdx: index('session_consumption_site_date_idx').on(
      t.siteId,
      t.sessionDate,
    ),
  }),
);

export const sessionConsumptionLines = pgTable(
  'session_consumption_lines',
  {
    id: pk(),
    companyId: companyId(),
    consumptionId: uuid('consumption_id')
      .notNull()
      .references(() => sessionConsumption.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull().references(() => products.id),
    /** Expected = recipe × covers (snapshotted at submit, stock_uom). */
    expectedQty: numeric('expected_qty', { precision: 18, scale: 3 }).notNull().default('0'),
    /** Actual used, as confirmed by the baker (the last-applied value — the
     *  amend delta is computed against it). */
    actualQty: numeric('actual_qty', { precision: 18, scale: 3 }).notNull().default('0'),
    wastageQty: numeric('wastage_qty', { precision: 18, scale: 3 }).notNull().default('0'),
    wastageReason: varchar('wastage_reason', { length: 200 }),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
    /** actual − expected. */
    variance: numeric('variance', { precision: 18, scale: 3 }).notNull().default('0'),
    stockUom: varchar('stock_uom', { length: 20 }).notNull().default('each'),
    ...auditTimestamps,
  },
  (t) => ({
    sessionConsumptionLinesUnq: uniqueIndex('session_consumption_lines_consumption_product_unq').on(
      t.consumptionId,
      t.productId,
    ),
  }),
);

export const sessionConsumptionRelations = relations(sessionConsumption, ({ one, many }) => ({
  site: one(sites, { fields: [sessionConsumption.siteId], references: [sites.id] }),
  lines: many(sessionConsumptionLines),
}));

export const sessionConsumptionLinesRelations = relations(sessionConsumptionLines, ({ one }) => ({
  consumption: one(sessionConsumption, {
    fields: [sessionConsumptionLines.consumptionId],
    references: [sessionConsumption.id],
  }),
  product: one(products, { fields: [sessionConsumptionLines.productId], references: [products.id] }),
}));
