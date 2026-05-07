/**
 * Channels — sales surfaces a product can be offered on.
 *
 * Each row is either an in-house storefront (apps/store, plus any
 * additional branded stores the business runs) OR a marketplace
 * connector (Amazon, eBay, Etsy, Shopify, …). The unified table lets
 * the catalogue model treat all routes-to-market identically: a
 * product is "offered on channel X at price Y" regardless of whether
 * X is the storefront or a marketplace.
 *
 * `product_channels` is the per-product join: a row with
 * `is_offered = true` and `price_override_gbp = NULL` is equivalent
 * to "no row at all" — both mean "default price, available on this
 * channel". Empty join table = "all channels, base price" (the
 * back-compat default for products that pre-date this feature).
 */
import { pgEnum, pgTable, varchar, boolean, decimal, jsonb, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, auditTimestamps } from './common.js';
import { products } from './products.js';

export const channelKindEnum = pgEnum('channel_kind', ['STOREFRONT', 'MARKETPLACE']);

export const channels = pgTable(
  'channels',
  {
    id: pk(),
    /** Stable URL-safe identifier, e.g. `filament-store`, `ebay-uk`. Unique. */
    slug: varchar('slug', { length: 80 }).notNull(),
    kind: channelKindEnum('kind').notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** Connector-specific config (Amazon seller ID, etc). Free-form JSON. */
    config: jsonb('config').$type<Record<string, unknown>>(),
    ...auditTimestamps,
  },
  (t) => ({
    channelsSlugUnq: uniqueIndex('channels_slug_unq').on(t.slug),
  }),
);

export const productChannels = pgTable(
  'product_channels',
  {
    id: pk(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    /** Whether the product is offered on this channel. Implicit true when
     *  the row is absent (back-compat with products that pre-date channels). */
    isOffered: boolean('is_offered').notNull().default(true),
    /** Per-channel override price in GBP. NULL = inherit the product's base
     *  selling price (`products.min_selling_price`). */
    priceOverrideGbp: decimal('price_override_gbp', { precision: 18, scale: 2 }),
    ...auditTimestamps,
  },
  (t) => ({
    productChannelsProductChannelUnq: uniqueIndex('product_channels_product_channel_unq').on(
      t.productId,
      t.channelId,
    ),
  }),
);

export const channelsRelations = relations(channels, ({ many }) => ({
  productChannels: many(productChannels),
}));

export const productChannelsRelations = relations(productChannels, ({ one }) => ({
  product: one(products, { fields: [productChannels.productId], references: [products.id] }),
  channel: one(channels, { fields: [productChannels.channelId], references: [channels.id] }),
}));
