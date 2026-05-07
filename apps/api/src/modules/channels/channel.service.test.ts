/**
 * Integration tests for ChannelService.
 *
 * Hits a real Postgres at DATABASE_URL. Inserts a single throwaway
 * product+group under a fixture company, then drives the upsert /
 * inheritance / getChannelPrice surface end-to-end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  channels,
  productChannels,
  productGroups,
  products,
} from '../../db/schema/index.js';
import { ChannelService } from './channel.service.js';

const COMPANY = '99999999-9999-4999-8999-999999999999';
const service = new ChannelService();

let groupId: string;
let productId: string;
let storefrontChannelId: string;
let amazonChannelId: string;

beforeAll(async () => {
  const db = getDb();
  // Channels table is seeded by the migration; pick the slugs we expect.
  const sf = await db.query.channels.findFirst({ where: eq(channels.slug, 'filament-store') });
  const az = await db.query.channels.findFirst({ where: eq(channels.slug, 'amazon-uk') });
  if (!sf || !az) throw new Error('Migration seed for channels missing');
  storefrontChannelId = sf.id;
  amazonChannelId = az.id;
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  const db = getDb();
  // Wipe in dependency order.
  const existing = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.companyId, COMPANY));
  if (existing.length > 0) {
    await db.delete(productChannels).where(inArray(productChannels.productId, existing.map((e) => e.id)));
    await db.delete(products).where(inArray(products.id, existing.map((e) => e.id)));
  }
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY));

  const [g] = await db
    .insert(productGroups)
    .values({ companyId: COMPANY, name: 'Channel Fixture Group', slug: 'channel-fix-group' })
    .returning();
  if (!g) throw new Error('group insert returned no row');
  groupId = g.id;

  const [p] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'Channel Fixture Product',
      slug: 'channel-fix-product',
      groupId,
      minSellingPrice: '10.00',
    })
    .returning();
  if (!p) throw new Error('product insert returned no row');
  productId = p.id;
});

describe('ChannelService.listActive', () => {
  it('returns the migration-seeded channels', async () => {
    const list = await service.listActive();
    const slugs = list.map((c) => c.slug);
    expect(slugs).toContain('filament-store');
    expect(slugs).toContain('amazon-uk');
    expect(slugs).toContain('ebay-uk');
    expect(slugs).toContain('etsy-uk');
    expect(slugs).toContain('shopify');
  });
});

describe('ChannelService.getRulesForProduct (inheritance)', () => {
  it('returns "offered at base price" for every channel when no rows exist', async () => {
    const rules = await service.getRulesForProduct(productId, '10.00');
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const r of rules) {
      expect(r.isOffered).toBe(true);
      expect(r.priceOverrideGbp).toBeNull();
      expect(r.priceGbp).toBe('10.00');
    }
  });

  it('reflects an explicit override on a single channel', async () => {
    await service.upsertRulesForProduct(productId, [
      { channelId: amazonChannelId, isOffered: true, priceOverrideGbp: '12.50' },
    ]);
    const rules = await service.getRulesForProduct(productId, '10.00');
    const amazon = rules.find((r) => r.channelId === amazonChannelId);
    const storefront = rules.find((r) => r.channelId === storefrontChannelId);
    expect(amazon?.priceGbp).toBe('12.50');
    expect(amazon?.priceOverrideGbp).toBe('12.50');
    expect(storefront?.priceGbp).toBe('10.00');
    expect(storefront?.priceOverrideGbp).toBeNull();
  });

  it('reflects is_offered=false', async () => {
    await service.upsertRulesForProduct(productId, [
      { channelId: amazonChannelId, isOffered: false, priceOverrideGbp: null },
    ]);
    const rules = await service.getRulesForProduct(productId, '10.00');
    expect(rules.find((r) => r.channelId === amazonChannelId)?.isOffered).toBe(false);
  });
});

describe('ChannelService.upsertRulesForProduct (sparseness)', () => {
  it('deletes default rows so the join table stays sparse', async () => {
    const db = getDb();
    // Insert an explicit override.
    await service.upsertRulesForProduct(productId, [
      { channelId: amazonChannelId, isOffered: true, priceOverrideGbp: '12.50' },
    ]);
    let rows = await db.query.productChannels.findMany({
      where: eq(productChannels.productId, productId),
    });
    expect(rows.length).toBe(1);

    // Now flip back to default — should remove the row.
    await service.upsertRulesForProduct(productId, [
      { channelId: amazonChannelId, isOffered: true, priceOverrideGbp: null },
    ]);
    rows = await db.query.productChannels.findMany({
      where: eq(productChannels.productId, productId),
    });
    expect(rows.length).toBe(0);
  });
});

describe('ChannelService.getChannelPrice', () => {
  it('returns the base price when no row exists', async () => {
    const price = await service.getChannelPrice(productId, storefrontChannelId);
    expect(price).toBe('10.00');
  });

  it('returns the override price when one is set', async () => {
    await service.upsertRulesForProduct(productId, [
      { channelId: amazonChannelId, isOffered: true, priceOverrideGbp: '12.50' },
    ]);
    const price = await service.getChannelPrice(productId, amazonChannelId);
    expect(price).toBe('12.50');
  });

  it('returns null when the product is not offered on the channel', async () => {
    await service.upsertRulesForProduct(productId, [
      { channelId: amazonChannelId, isOffered: false, priceOverrideGbp: null },
    ]);
    const price = await service.getChannelPrice(productId, amazonChannelId);
    expect(price).toBeNull();
  });

  it('returns null when the product does not exist', async () => {
    const price = await service.getChannelPrice(
      '00000000-0000-4000-8000-000000000000',
      storefrontChannelId,
    );
    expect(price).toBeNull();
  });
});
