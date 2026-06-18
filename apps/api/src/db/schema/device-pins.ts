import { pgTable, varchar, uuid, text, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
