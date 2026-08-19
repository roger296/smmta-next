/**
 * Integration test for the existing GET /api/v1/products route — proves it
 * surfaces the new storefront fields after `seed:storefront` has run.
 *
 * Mirrors Prompt 1 acceptance: "After running the seed, GET /api/v1/products
 * (admin auth) returns the new fields."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { closeDatabase } from '../../config/database.js';
import {
  STOREFRONT_DEMO_COMPANY_ID,
  seedStorefront,
} from '../../../scripts/seed-storefront.js';

let app: FastifyInstance;
let token: string;

/**
 * Minimal in-memory catalogue fixture. Seeds two products in one group
 * (Landau PLA Basic, Black + White) so the route test can assert
 * storefront fields without depending on a particular xlsx export.
 */
const FIXTURE_ROWS = [
  {
    stockCode: 'V3-PLA-BAS-BLACK',
    manufacturer: 'Landau',
    fullyQualifiedName: '1Kg Roll of FDM Printer Filament BLACK PLA Basic',
    oldGroupId: 55118,
    description: '1Kg Roll of FDM Printer Filament',
    netWeight: 1,
    shippingWeight: 1.3,
    dimensionH: 19,
    dimensionW: 19,
    dimensionD: 7,
    measurementUnit: 'cm',
    sellingPrice: 6.0,
    expectedNextCost: 3.42,
    rawColour: 'BLACKPLA Basic',
    stockQty: 5,
    imageUrl: 'https://example.com/landau-pla-basic-black.png',
  },
  {
    stockCode: 'V3-PLA-BAS-WHITE',
    manufacturer: 'Landau',
    fullyQualifiedName: '1Kg Roll of FDM Printer Filament WHITE PLA Basic',
    oldGroupId: 55118,
    description: '1Kg Roll of FDM Printer Filament',
    netWeight: 1,
    shippingWeight: 1.3,
    dimensionH: 19,
    dimensionW: 19,
    dimensionD: 7,
    measurementUnit: 'cm',
    sellingPrice: 6.0,
    expectedNextCost: 3.42,
    rawColour: 'WHITEPLA Basic',
    stockQty: 0,
    imageUrl: 'https://example.com/landau-pla-basic-white.png',
  },
];

beforeAll(async () => {
  // Match the JWT_SECRET default in env.ts so jwt.sign here matches
  // jwt.verify inside the app under test.
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';

  app = await buildApp();
  await app.ready();

  token = app.jwt.sign({
    userId: 'test-user',
    companyId: STOREFRONT_DEMO_COMPANY_ID,
    email: 'test@storefront-demo.invalid',
    roles: ['admin'],
  });

  await seedStorefront({ rows: FIXTURE_ROWS });
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

describe('GET /api/v1/products — returns storefront fields', () => {
  it('returns seeded variants with colour, slug, hero image, and SEO fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${token}` },
      query: { search: 'Landau' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: Array<Record<string, unknown>>;
    };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(FIXTURE_ROWS.length);

    const black = body.data.find((p) => p.slug === 'landau-pla-basic-1-75mm-1kg-black');
    expect(black).toBeDefined();
    expect(black?.colour).toBe('Black');
    expect(black?.colourHex).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(black?.isPublished).toBe(true);
    expect(black?.heroImageUrl).toMatch(/^https:\/\//);
    expect(black?.seoTitle).toContain('Black');
    expect(typeof black?.groupId).toBe('string');
    expect(typeof black?.sortOrderInGroup).toBe('number');
  });

  // ── D-1: the cap that made every stock-take row unreadable on 12 Aug ─────
  it('D-1: GET /products?pageSize=500 is a 400 naming the cap, not a short page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${token}` },
      query: { pageSize: '500' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { success: boolean; error: string; details?: Array<{ message: string }> };
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).toContain('250');
  });

  it('D-1: GET /products?pageSize=250 succeeds — the cap itself is allowed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${token}` },
      query: { pageSize: '250' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { pageSize: number }).pageSize).toBe(250);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
    });
    expect(res.statusCode).toBe(401);
  });
});
