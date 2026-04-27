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

  await seedStorefront();
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

describe('GET /api/v1/products — returns storefront fields', () => {
  it('returns Aurora variants with colour, slug, hero image, and SEO fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${token}` },
      query: { search: 'Aurora' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: Array<Record<string, unknown>>;
    };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(3);

    const smoke = body.data.find((p) => p.slug === 'aurora-filament-lamp-smoke');
    expect(smoke).toBeDefined();
    expect(smoke?.colour).toBe('Smoke');
    expect(smoke?.colourHex).toBe('#3a3a3a');
    expect(smoke?.isPublished).toBe(true);
    expect(smoke?.heroImageUrl).toMatch(/^https:\/\/picsum\.photos\//);
    expect(smoke?.seoTitle).toContain('Smoke');
    expect(typeof smoke?.groupId).toBe('string');
    // sortOrderInGroup is an integer column with default 0
    expect(typeof smoke?.sortOrderInGroup).toBe('number');
  });

  it('returns the standalone product with groupId = null', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${token}` },
      query: { search: 'Pendant' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<Record<string, unknown>>;
    };
    const standalone = body.data.find((p) => p.slug === 'brushed-brass-pendant-cord-set');
    expect(standalone).toBeDefined();
    expect(standalone?.groupId).toBeNull();
    expect(standalone?.isPublished).toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
    });
    expect(res.statusCode).toBe(401);
  });
});
