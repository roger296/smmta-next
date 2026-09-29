import {
  pgTable,
  varchar,
  uuid,
  numeric,
  smallint,
  text,
  time,
  boolean,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps } from './common.js';
import { suppliers } from './purchasing.js';
import { sites } from './sites.js';

// ============================================================
// Supplier accounts per site (supplier-ordering groundwork, Sept 2026)
// ------------------------------------------------------------
// Brakes, Booker and LWC know each venue by its OWN account, deliver to it on
// its own days from its own depot, and hold it to its own cut-off and minimum.
// Those facts are what turn "cheapest" into "cheapest that arrives before we
// run out" (docs/plans/SUPPLIER_ORDERING_PLAN.md §3.2, §4.2), so they live
// per (supplier, site), not on the supplier.
//
// Two ways to describe when an order arrives, and an account uses one:
//   - a delivery CALENDAR: `delivery_days` + `cutoff_time` +
//     `cutoff_days_before` (Brakes: Tue/Thu, order by 16:00 the day before);
//   - a LEAD TIME: `lead_days` working days (a web shop or courier with no
//     fixed round).
// See modules/suppliers/delivery-calendar.ts, which is the only reader of
// these columns' meaning. Times are the SITE's wall clock.
// ============================================================

export const supplierSiteAccounts = pgTable(
  'supplier_site_accounts',
  {
    id: pk(),
    companyId: companyId(),
    supplierId: uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    /** The supplier's account number for this venue. */
    accountNumber: varchar('account_number', { length: 60 }),
    /** The supplier's electronic identifier for this venue, where it has one
     *  (a Booker EDI location ID, a GLN). */
    ediLocationId: varchar('edi_location_id', { length: 60 }),
    /** ISO weekday codes the supplier delivers to this venue: MON…SUN. Empty =
     *  no fixed round (use `lead_days`). */
    deliveryDays: varchar('delivery_days', { length: 3 }).array().notNull().default([]),
    /** Latest order time, site wall clock. NULL = any time that day. */
    cutoffTime: time('cutoff_time'),
    /** How many days before the delivery day the cut-off falls (1 = the day before). */
    cutoffDaysBefore: smallint('cutoff_days_before').notNull().default(1),
    /** Working days from order to delivery, for an account with no round. */
    leadDays: smallint('lead_days'),
    minOrderValue: numeric('min_order_value', { precision: 12, scale: 2 }),
    deliveryCharge: numeric('delivery_charge', { precision: 12, scale: 2 }),
    /** Order value at or above which delivery is free. */
    freeDeliveryOver: numeric('free_delivery_over', { precision: 12, scale: 2 }),
    /** Where POs for THIS venue go, when it differs from the supplier's
     *  `order_email` (an LWC depot, a Brakes branch). */
    orderEmail: varchar('order_email', { length: 200 }),
    portalUrl: varchar('portal_url', { length: 500 }),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    ...auditTimestamps,
  },
  (t) => ({
    supplierSiteAccountsUnq: uniqueIndex('supplier_site_accounts_company_supplier_site_unq').on(
      t.companyId,
      t.supplierId,
      t.siteId,
    ),
  }),
);

export const supplierSiteAccountsRelations = relations(supplierSiteAccounts, ({ one }) => ({
  supplier: one(suppliers, { fields: [supplierSiteAccounts.supplierId], references: [suppliers.id] }),
  site: one(sites, { fields: [supplierSiteAccounts.siteId], references: [sites.id] }),
}));
