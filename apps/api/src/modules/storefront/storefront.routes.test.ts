/**
 * Integration tests for /api/v1/storefront/* read endpoints.
 *
 * Covers:
 *   - published / unpublished filtering
 *   - 404 on unknown slug
 *   - available_qty correctness (IN_STOCK only, not RESERVED/ALLOCATED)
 *   - JWT (instead of api key) → 401
 *   - api key without storefront:read scope → 403
 *   - Cache-Control header on every successful response
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  apiKeys,
  productGroups,
  products,
  stockItems,
  warehouses,
} from '../../db/schema/index.js';
import { ApiKeyService } from '../admin/api-keys.service.js';

const COMPANY_ID = '77777777-7777-4777-8777-777777777777';

let app: FastifyInstance;
let readKey: string;
let noScopeKey: string;
let jwt: string;

interface SeededIds {
  publishedGroupId: string;
  variantPublishedSlug: string; // 'aurora-smoke'
  variantUnpublishedSlug: string; // 'aurora-violet' (unpublished, in published group)
  unpublishedGroupId: string;
  unpublishedGroupSlug: string;
  unpublishedGroupVariantSlug: string;
  standaloneId: string;
  standaloneSlug: string;
}

async function wipeAndSeed(): Promise<SeededIds> {
  const db = getDb();
  // Wipe everything for this test company.
  await db.delete(stockItems).where(eq(stockItems.companyId, COMPANY_ID));
  await db.delete(products).where(eq(products.companyId, COMPANY_ID));
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY_ID));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY_ID));

  const [warehouse] = await db
    .insert(warehouses)
    .values({ companyId: COMPANY_ID, name: 'Storefront Test WH', isDefault: true })
    .returning({ id: warehouses.id });
  if (!warehouse) throw new Error('seed: warehouse');

  const [publishedGroup] = await db
    .insert(productGroups)
    .values({
      companyId: COMPANY_ID,
      name: 'Aurora Range',
      slug: 'aurora-range',
      shortDescription: 'A short description.',
      heroImageUrl: 'https://example.com/aurora-hero.jpg',
      seoTitle: 'Aurora Range',
      seoDescription: 'Designer LED lamps.',
      isPublished: true,
      sortOrder: 0,
    })
    .returning({ id: productGroups.id });
  if (!publishedGroup) throw new Error('seed: published group');

  const [unpublishedGroup] = await db
    .insert(productGroups)
    .values({
      companyId: COMPANY_ID,
      name: 'Hidden Range',
      slug: 'hidden-range',
      isPublished: false,
    })
    .returning({ id: productGroups.id, slug: productGroups.slug });
  if (!unpublishedGroup) throw new Error('seed: unpublished group');

  const variantRows = await db
    .insert(products)
    .values([
      {
        companyId: COMPANY_ID,
        name: 'Aurora — Smoke',
        groupId: publishedGroup.id,
        slug: 'aurora-smoke',
        colour: 'Smoke',
        colourHex: '#3a3a3a',
        minSellingPrice: '24.00',
        heroImageUrl: 'https://example.com/aurora-smoke.jpg',
        isPublished: true,
        sortOrderInGroup: 0,
      },
      {
        companyId: COMPANY_ID,
        name: 'Aurora — Amber',
        groupId: publishedGroup.id,
        slug: 'aurora-amber',
        colour: 'Amber',
        colourHex: '#d97706',
        minSellingPrice: '34.00',
        heroImageUrl: 'https://example.com/aurora-amber.jpg',
        isPublished: true,
        sortOrderInGroup: 1,
      },
      {
        companyId: COMPANY_ID,
        name: 'Aurora — Violet',
        groupId: publishedGroup.id,
        slug: 'aurora-violet',
        colour: 'Violet',
        colourHex: '#7c3aed',
        minSellingPrice: '29.00',
        heroImageUrl: 'https://example.com/aurora-violet.jpg',
        isPublished: false, // unpublished variant in a published group
        sortOrderInGroup: 2,
      },
      {
        companyId: COMPANY_ID,
        name: 'Hidden Variant',
        groupId: unpublishedGroup.id,
        slug: 'hidden-variant',
        minSellingPrice: '10.00',
        isPublished: true, // published, but the parent group is hidden
      },
      {
        companyId: COMPANY_ID,
        name: 'Brushed Brass Pendant',
        groupId: null,
        slug: 'brushed-brass-pendant',
        minSellingPrice: '18.00',
        heroImageUrl: 'https://example.com/pendant.jpg',
        isPublished: true,
      },
    ])
    .returning({ id: products.id, slug: products.slug });

  const smokeId = variantRows.find((v) => v.slug === 'aurora-smoke')!.id;
  const amberId = variantRows.find((v) => v.slug === 'aurora-amber')!.id;
  const violetId = variantRows.find((v) => v.slug === 'aurora-violet')!.id;
  const standaloneId = variantRows.find((v) => v.slug === 'brushed-brass-pendant')!.id;

  // Seed stock_items.
  // Smoke: 5 IN_STOCK, 2 RESERVED, 1 ALLOCATED → available_qty = 5
  // Amber: 0 IN_STOCK
  // Standalone: 3 IN_STOCK
  await db.insert(stockItems).values([
    ...Array.from({ length: 5 }, () => ({
      companyId: COMPANY_ID,
      productId: smokeId,
      warehouseId: warehouse.id,
      status: 'IN_STOCK' as const,
    })),
    ...Array.from({ length: 2 }, () => ({
      companyId: COMPANY_ID,
      productId: smokeId,
      warehouseId: warehouse.id,
      status: 'RESERVED' as const,
    })),
    {
      companyId: COMPANY_ID,
      productId: smokeId,
      warehouseId: warehouse.id,
      status: 'ALLOCATED' as const,
    },
    ...Array.from({ length: 3 }, () => ({
      companyId: COMPANY_ID,
      productId: standaloneId,
      warehouseId: warehouse.id,
      status: 'IN_STOCK' as const,
    })),
  ]);

  return {
    publishedGroupId: publishedGroup.id,
    variantPublishedSlug: 'aurora-smoke',
    variantUnpublishedSlug: 'aurora-violet',
    unpublishedGroupId: unpublishedGroup.id,
    unpublishedGroupSlug: 'hidden-range',
    unpublishedGroupVariantSlug: 'hidden-variant',
    standaloneId,
    standaloneSlug: 'brushed-brass-pendant',
  };
}

let seeded: SeededIds;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();

  jwt = app.jwt.sign({
    userId: 'op',
    companyId: COMPANY_ID,
    email: 'op@example.invalid',
    roles: ['admin'],
  });

  // Clean slate for api keys belonging to this test company (prior runs may
  // have left rows behind — issuing keys with duplicate names within the
  // same company would otherwise 409 in beforeAll).
  const db = getDb();
  await db.delete(apiKeys).where(eq(apiKeys.companyId, COMPANY_ID));

  // Issue api keys directly via the service so tests don't depend on the
  // admin route plumbing for setup.
  const service = new ApiKeyService();
  const ok = await service.issue(COMPANY_ID, {
    name: 'storefront-read-test',
    scopes: ['storefront:read'],
  });
  readKey = ok.rawKey;
  const ng = await service.issue(COMPANY_ID, {
    name: 'storefront-no-scope-test',
    scopes: [],
  });
  noScopeKey = ng.rawKey;
});

beforeEach(async () => {
  seeded = await wipeAndSeed();
});

afterAll(async () => {
  const db = getDb();
  await db.delete(stockItems).where(eq(stockItems.companyId, COMPANY_ID));
  await db.delete(products).where(eq(products.companyId, COMPANY_ID));
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY_ID));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY_ID));
  await db.delete(apiKeys).where(eq(apiKeys.companyId, COMPANY_ID));
  await app.close();
  await closeDatabase();
});

// ---------------------------------------------------------------------------
// GET /storefront/groups
// ---------------------------------------------------------------------------

describe('GET /storefront/groups', () => {
  it('returns published groups only, with thin variants and stock counts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/groups',
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=60');

    const body = res.json() as {
      data: Array<{
        slug: string;
        name: string;
        priceRange: { min: string; max: string } | null;
        totalAvailableQty: number;
        variants: Array<{ slug: string; colour: string; availableQty: number; priceGbp: string | null }>;
      }>;
    };

    expect(body.data).toHaveLength(1);
    const [g] = body.data;
    expect(g?.slug).toBe('aurora-range');
    expect(g?.name).toBe('Aurora Range');

    // Only published variants — Violet is unpublished, must be excluded.
    expect(g?.variants.map((v) => v.slug).sort()).toEqual(['aurora-amber', 'aurora-smoke']);

    // available_qty: smoke has 5 IN_STOCK, amber 0.
    const smoke = g!.variants.find((v) => v.slug === 'aurora-smoke')!;
    const amber = g!.variants.find((v) => v.slug === 'aurora-amber')!;
    expect(smoke.availableQty).toBe(5);
    expect(amber.availableQty).toBe(0);
    expect(g!.totalAvailableQty).toBe(5);

    // priceRange is across published variants only (no Violet).
    expect(g?.priceRange).toEqual({ min: '24.00', max: '34.00' });
  });
});

// ---------------------------------------------------------------------------
// GET /storefront/groups/:slug
// ---------------------------------------------------------------------------

describe('GET /storefront/groups/:slug', () => {
  it('returns a published group with full variant content', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/groups/aurora-range',
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=60');
    const body = res.json() as { data: { variants: Array<{ slug: string; longDescription: string | null }> } };
    expect(body.data.variants).toHaveLength(2); // Smoke + Amber, no Violet
  });

  it('404s for an unpublished group slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/storefront/groups/${seeded.unpublishedGroupSlug}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s for a slug that does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/groups/no-such-thing',
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /storefront/products/:slug
// ---------------------------------------------------------------------------

describe('GET /storefront/products/:slug', () => {
  it('returns a standalone published product', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/storefront/products/${seeded.standaloneSlug}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { slug: string; groupId: string | null; availableQty: number } };
    expect(body.data.slug).toBe(seeded.standaloneSlug);
    expect(body.data.groupId).toBeNull();
    expect(body.data.availableQty).toBe(3);
  });

  it('returns a grouped published variant by its own slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/storefront/products/${seeded.variantPublishedSlug}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { slug: string; groupId: string | null; colour: string | null } };
    expect(body.data.slug).toBe(seeded.variantPublishedSlug);
    expect(body.data.groupId).toBe(seeded.publishedGroupId);
    expect(body.data.colour).toBe('Smoke');
  });

  it('404s for an unpublished product', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/storefront/products/${seeded.variantUnpublishedSlug}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /storefront/products?ids=
// ---------------------------------------------------------------------------

describe('GET /storefront/products?ids=', () => {
  it('returns published products by id, omitting unknown / unpublished ones', async () => {
    const db = getDb();
    const all = await db
      .select({ id: products.id, slug: products.slug, isPublished: products.isPublished })
      .from(products)
      .where(and(eq(products.companyId, COMPANY_ID), isNull(products.deletedAt)));
    const violetId = all.find((r) => r.slug === 'aurora-violet')!.id;
    const standaloneId = seeded.standaloneId;
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const ids = [violetId, standaloneId, fakeId].join(',');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/storefront/products?ids=${ids}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string; slug: string }> };
    expect(body.data.map((p) => p.slug)).toEqual(['brushed-brass-pendant']);
  });

  it('400s on missing ids parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/products',
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s on a non-uuid id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/products?ids=not-a-uuid',
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Auth and scope checks
// ---------------------------------------------------------------------------

describe('storefront read auth', () => {
  it('rejects a JWT with 401 (api key required)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/groups',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects an api key without storefront:read scope with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/groups',
      headers: { authorization: `Bearer ${noScopeKey}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects requests without an Authorization header with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storefront/groups',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });
});

// ---------------------------------------------------------------------------
// OpenAPI doc surface
// ---------------------------------------------------------------------------

describe('OpenAPI /docs/json', () => {
  it('lists the storefront read endpoints under the storefront tag', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    expect(body.paths['/api/v1/storefront/groups']).toBeDefined();
    expect(body.paths['/api/v1/storefront/groups/{slug}']).toBeDefined();
    expect(body.paths['/api/v1/storefront/products']).toBeDefined();
    expect(body.paths['/api/v1/storefront/products/{slug}']).toBeDefined();
    expect(body.paths['/api/v1/storefront/groups']?.get?.tags).toContain('storefront');
  });
});
