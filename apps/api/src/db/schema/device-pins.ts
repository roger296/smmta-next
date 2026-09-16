import { pgTable, varchar, uuid, text, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { pk, companyId, auditTimestamps } from './common.js';
import { sites } from './sites.js';

// ============================================================
// Device PINs (spec §A11, §A12 q10) — shared iPad per-user login
// ------------------------------------------------------------
// Shared site iPads: each person has a PIN scoped to their site + roles.
// The PIN is scrypt-hashed (the same helper as user passwords); pin-login
// verifies it and issues a short-lived scoped JWT.
// ============================================================

export const devicePins = pgTable('device_pins', {
  id: pk(),
  companyId: companyId(),
  /** The site the PIN is scoped to (NULL = any site). */
  siteId: uuid('site_id').references(() => sites.id),
  /** The person's display name (shown on the shared device). */
  label: varchar('label', { length: 120 }).notNull(),
  pinHash: text('pin_hash').notNull(),
  roles: text('roles').array().notNull().default(sql`ARRAY['head_baker']::text[]`),
  isActive: boolean('is_active').notNull().default(true),
  ...auditTimestamps,
});

// ============================================================
// Extra venues a PIN may work at (Sept-2026 user testing, item 1)
// ------------------------------------------------------------
// "some head bakers work at two locations, so we need … a system that defaults
//  to a single location but has the option to add extra locations."
//
// `device_pins.site_id` above stays the HOME venue: the one the PIN defaults
// to, and the one every token already issued carries. This table holds the
// extras, so a PIN with none behaves exactly as it does today.
//
// Each row is its own audit entry. Self-service was the owner's decision, on
// the condition that every addition is visible and reversible — so the row
// records when the venue was added and by whom, and deleting it is the revoke.
// ============================================================

export const devicePinSites = pgTable(
  'device_pin_sites',
  {
    id: pk(),
    companyId: companyId(),
    devicePinId: uuid('device_pin_id')
      .notNull()
      .references(() => devicePins.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** 'SELF' — the baker added it from the iPad. 'ADMIN' — head office did. */
    addedVia: varchar('added_via', { length: 10 }).notNull().default('SELF'),
    addedBy: varchar('added_by', { length: 200 }),
    ...auditTimestamps,
  },
  (t) => ({
    devicePinSitesUnq: uniqueIndex('device_pin_sites_pin_site_unq').on(t.devicePinId, t.siteId),
    devicePinSitesPinIdx: index('device_pin_sites_pin_idx').on(t.devicePinId),
  }),
);

export const devicePinsRelations = relations(devicePins, ({ many }) => ({
  extraSites: many(devicePinSites),
}));

export const devicePinSitesRelations = relations(devicePinSites, ({ one }) => ({
  pin: one(devicePins, { fields: [devicePinSites.devicePinId], references: [devicePins.id] }),
  site: one(sites, { fields: [devicePinSites.siteId], references: [sites.id] }),
}));
