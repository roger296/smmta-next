/**
 * GET /storefront/groups for keys bound to a channel.
 *
 * Two storefronts share one catalogue: each key must see what its own channel
 * offers, plus products that pre-date channels (no rows at all), and nothing
 * scoped to another channel. The filtering happens in the database, so these
 * run against a real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { apiKeys, channels, productChannels, productGroups, products } from '../../db/schema/index.js';
import { ApiKeyService } from '../admin/api-keys.service.js';

const COMPANY_ID = '66666666-6666-4666-8666-666666666666';
const FILAMENT = 'test-scope-filament';
const CLOTHES = 'test-scope-clothes';

let app: FastifyInstance;
let filamentKey: string;
let clothesKey: string;
let unboundKey: string;
const channelIds: Record<string, string> = {};

async function wipe() {
  const db = getDb();
  await db.delete(products).where(eq(products.companyId, COMPANY_ID));
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY_ID));
}

async function seed() {
  const db = getDb();
  const groupRows = await db
    .insert(productGroups)
    .values([
      { companyId: COMPANY_ID, name: 'Filament Range', slug: 'scope-filament-range', isPublished: true, sortOrder: 1 },
      { companyId: COMPANY_ID, name: 'Clothes Range', slug: 'scope-clothes-range', isPublished: true, sortOrder: 2 },
      { companyId: COMPANY_ID, name: 'Legacy Range', slug: 'scope-legacy-range', isPublished: true, sortOrder: 3 },
    ])
    .returning({ id: productGroups.id, slug: productGroups.slug });
  const group = (slug: string) => groupRows.find((g) => g.slug === slug)!.id;

  const productRows = await db
    .insert(products)
    .values([
      { companyId: COMPANY_ID, name: 'PLA Green', slug: 'scope-pla-green', groupId: group('scope-filament-range'), minSellingPrice: '20.00', isPublished: true },
      { companyId: COMPANY_ID, name: 'PLA Hidden', slug: 'scope-pla-hidden', groupId: group('scope-filament-range'), minSellingPrice: '20.00', isPublished: true },
      { companyId: COMPANY_ID, name: 'Tee M', slug: 'scope-tee-m', groupId: group('scope-clothes-range'), minSellingPrice: '12.00', isPublished: true },
      { companyId: COMPANY_ID, name: 'Legacy Spool', slug: 'scope-legacy-spool', groupId: group('scope-legacy-range'), minSellingPrice: '9.00', isPublished: true },
    ])
    .returning({ id: products.id, slug: products.slug });
  const product = (slug: string) => productRows.find((p) => p.slug === slug)!.id;

  await db.insert(productChannels).values([
    // Offered on the filament channel at an override price.
    { productId: product('scope-pla-green'), channelId: channelIds[FILAMENT]!, priceOverrideGbp: '18.50' },
    // Scoped to the filament channel but switched off there.
    { productId: product('scope-pla-hidden'), channelId: channelIds[FILAMENT]!, isOffered: false },
    // Clothing, scoped to the clothes channel only.
    { productId: product('scope-tee-m'), channelId: channelIds[CLOTHES]! },
    // Legacy Spool has no rows: offered everywhere.
  ]);
}

async function groupsFor(key: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/storefront/groups',
    headers: { authorization: `Bearer ${key}` },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: Array<{ slug: string; variants: Array<{ slug: string; priceGbp: string | null }> }> }).data;
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();

  const db = getDb();
  await wipe();
  await db.delete(apiKeys).where(eq(apiKeys.companyId, COMPANY_ID));
  await db.delete(channels).where(inArray(channels.slug, [FILAMENT, CLOTHES]));
  const created = await db
    .insert(channels)
    .values([
      { slug: FILAMENT, kind: 'STOREFRONT', displayName: 'Scope test filament' },
      { slug: CLOTHES, kind: 'STOREFRONT', displayName: 'Scope test clothes' },
    ])
    .returning({ id: channels.id, slug: channels.slug });
  for (const c of created) channelIds[c.slug] = c.id;

  const service = new ApiKeyService();
  const issue = async (name: string, channelId: string | null) => {
    const { row, rawKey } = await service.issue(COMPANY_ID, { name, scopes: ['storefront:read'] });
    if (channelId) await db.update(apiKeys).set({ channelId }).where(eq(apiKeys.id, row.id));
    return rawKey;
  };
  filamentKey = await issue('scope-filament-key', channelIds[FILAMENT]!);
  clothesKey = await issue('scope-clothes-key', channelIds[CLOTHES]!);
  unboundKey = await issue('scope-unbound-key', null);
});

beforeEach(async () => {
  await wipe();
  await seed();
});

afterAll(async () => {
  const db = getDb();
  await wipe();
  await db.delete(apiKeys).where(eq(apiKeys.companyId, COMPANY_ID));
  await db.delete(channels).where(inArray(channels.slug, [FILAMENT, CLOTHES]));
  await app.close();
  await closeDatabase();
});

describe('GET /storefront/groups with a channel-bound key', () => {
  it('shows its own channel and unscoped products, at its channel price, and nothing of another channel', async () => {
    const groups = await groupsFor(filamentKey);
    expect(groups.map((g) => g.slug)).toEqual(['scope-filament-range', 'scope-legacy-range']);
    const filament = groups.find((g) => g.slug === 'scope-filament-range')!;
    // PLA Hidden is scoped here but not offered.
    expect(filament.variants.map((v) => [v.slug, v.priceGbp])).toEqual([['scope-pla-green', '18.50']]);
  });

  it('shows the other storefront its own products, plus unscoped ones', async () => {
    const groups = await groupsFor(clothesKey);
    // Products with no channel rows are offered everywhere, so a shop that must
    // not show them has to give them rows for their own channel.
    expect(groups.map((g) => g.slug)).toEqual(['scope-clothes-range', 'scope-legacy-range']);
  });

  it('returns nothing when the channel offers nothing', async () => {
    await getDb().delete(products).where(eq(products.slug, 'scope-legacy-spool'));
    await getDb().delete(products).where(eq(products.slug, 'scope-tee-m'));
    expect(await groupsFor(clothesKey)).toEqual([]);
  });

  it('returns only the first ranges by sort order when a limit is given', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/groups?limit=2',
      headers: { authorization: `Bearer ${unboundKey}` },
    });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: Array<{ slug: string; variants: unknown[] }> }).data;
    expect(data.map((g) => g.slug)).toEqual(['scope-filament-range', 'scope-clothes-range']);
    expect(data[0]?.variants).toHaveLength(2);

    // Within a channel, the limit applies to the ranges that channel offers.
    const scoped = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/groups?limit=1',
      headers: { authorization: `Bearer ${clothesKey}` },
    });
    expect((scoped.json() as { data: Array<{ slug: string }> }).data.map((g) => g.slug)).toEqual([
      'scope-clothes-range',
    ]);

    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/groups?limit=0',
      headers: { authorization: `Bearer ${unboundKey}` },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('shows an unbound key every published range, at base prices', async () => {
    const groups = await groupsFor(unboundKey);
    expect(groups.map((g) => g.slug)).toEqual([
      'scope-filament-range',
      'scope-clothes-range',
      'scope-legacy-range',
    ]);
    const filament = groups.find((g) => g.slug === 'scope-filament-range')!;
    expect(filament.variants.map((v) => v.priceGbp)).toEqual(['20.00', '20.00']);
  });
});
