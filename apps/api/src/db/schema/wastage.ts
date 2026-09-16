import {
  pgTable,
  varchar,
  uuid,
  numeric,
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
// Wastage events (Sept-2026 user testing, item 7)
// ------------------------------------------------------------
// "please take this wastage function out of the end of bake form and create a
//  separate Wastage form linked to by a new main menu item on the PWA where any
//  items from stock can be marked as wasted."
//
// Wastage used to be a triangle on each ingredient row of the end-of-bake form,
// which meant it could only ever be recorded for something a recipe expected,
// during a bake, by the person filing that bake. A dropped case of eggs on a
// Tuesday morning had nowhere to go.
//
// Each row writes ONE WASTAGE stock movement. The movement ledger holds the
// quantity; this table holds everything a person needs to make sense of it
// later — the reason, the note, who said so, and optionally which bake it
// happened during. `stock_movements` has no room for any of that.
// ============================================================

export const wastageEvents = pgTable(
  'wastage_events',
  {
    id: pk(),
    companyId: companyId(),
    siteId: uuid('site_id').notNull().references(() => sites.id),
    productId: uuid('product_id').notNull().references(() => products.id),
    /** Always positive — the movement it writes is the negative one. */
    qty: numeric('qty', { precision: 18, scale: 3 }).notNull(),
    stockUom: varchar('stock_uom', { length: 20 }).notNull(),
    /** Why. Required: wastage with no reason is indistinguishable from a
     *  counting error, and cannot be acted on by anyone. */
    reason: varchar('reason', { length: 200 }).notNull(),
    note: text('note'),
    /** Who recorded it — the PIN label or a typed name. */
    recordedBy: varchar('recorded_by', { length: 200 }),
    /**
     * Optional link to the bake it happened during (owner's decision,
     * Sept-2026). Left optional on purpose: most waste is not part of a bake,
     * and forcing a "not a bake" answer onto every dropped delivery box would
     * add a step to the commonest case. When it IS given, the session's true
     * cost can still account for it.
     */
    sessionId: varchar('session_id', { length: 200 }),
    bake: varchar('bake', { length: 200 }),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('GBP'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Offline idempotency — a replayed submit finds its own row and stops. */
    clientKey: varchar('client_key', { length: 200 }).notNull(),
    ...auditTimestamps,
  },
  (t) => ({
    wastageEventsClientKeyUnq: uniqueIndex('wastage_events_company_client_key_unq').on(
      t.companyId,
      t.clientKey,
    ),
    wastageEventsSiteDateIdx: index('wastage_events_site_occurred_idx').on(t.siteId, t.occurredAt),
  }),
);

export const wastageEventsRelations = relations(wastageEvents, ({ one }) => ({
  site: one(sites, { fields: [wastageEvents.siteId], references: [sites.id] }),
  product: one(products, { fields: [wastageEvents.productId], references: [products.id] }),
}));
