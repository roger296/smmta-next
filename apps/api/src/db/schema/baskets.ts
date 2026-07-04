/**
 * Agent/storefront basket (SPEC §14). A basket is linked to a chat session
 * (chat_sessions.basketId) or a logged-in user. Lines carry the pool ('warehouse'
 * or an inbound shipment ref); prices are NEVER stored on the line — the basket
 * view re-quotes through the pricing engine every time, so a line can't hold a
 * stale or tampered price.
 */
import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';
import { storefrontUsers } from './identity.js';

export const baskets = pgTable('baskets', {
  id: pk(),
  companyId: companyId(),
  userId: uuid('user_id').references(() => storefrontUsers.id), // nullable: anonymous
  appliedCode: text('applied_code'), // best-of vs structural, resolved at view time
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const basketLines = pgTable('basket_lines', {
  id: pk(),
  companyId: companyId(),
  basketId: uuid('basket_id')
    .notNull()
    .references(() => baskets.id),
  sku: text('sku').notNull(),
  qty: integer('qty').notNull(),
  pool: text('pool').notNull().default('warehouse'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
