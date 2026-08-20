/**
 * Sites admin API (P2, spec §A5). Exercises create / list / get / update plus
 * slug-uniqueness (409) and validation (400) against a real Postgres + the
 * built app. Sites are created under the singleton company; afterAll removes
 * only the slugs this test introduced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { devicePins, sites } from '../../db/schema/index.js';

const SLUGS = [
  'rtest-leeds',
  'rtest-bristol',
  // F-7 fixture (Aug-2026 feedback set). The per-site bench ratio the other
  // fixtures here tested was removed in F16 — a bench and a table are the
  // same thing — so only the "it stays gone" slug remains.
  'bench-gone',
];
let app: FastifyInstance;
let token: string;

async function cleanup(): Promise<void> {
  const db = getDb();
  // Device pins first. `seed-head-baker-pins` mints one per site, so a fixture
  // site left behind by an interrupted run acquires a PIN and can no longer be
  // deleted by slug — the FK refuses and every test in this file then skips.
  const mine = await db
    .select({ id: sites.id })
    .from(sites)
    .where(inArray(sites.slug, SLUGS));
  if (mine.length > 0) {
    await db.delete(devicePins).where(inArray(devicePins.siteId, mine.map((s) => s.id)));
  }
  await db.delete(sites).where(inArray(sites.slug, SLUGS));
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  token = app.jwt.sign({
    userId: 'test-user',
    companyId: '11111111-1111-4111-8111-111111111111',
    email: 'test@autostock.invalid',
    roles: ['admin'],
  });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('Sites admin API', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sites' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a site, lists it, and fetches it by id', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: auth(),
      payload: { slug: 'rtest-leeds', name: 'Leeds' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json().data;
    expect(created.slug).toBe('rtest-leeds');
    expect(created.canonicalName).toBe('Leeds'); // defaults to name
    expect(created.currencyCode).toBe('GBP');
    expect(created.uomSystem).toBe('METRIC');

    const list = await app.inject({ method: 'GET', url: '/api/v1/sites', headers: auth() });
    expect(list.statusCode).toBe(200);
    const slugs = list.json().data.map((s: { slug: string }) => s.slug);
    expect(slugs).toContain('rtest-leeds');

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${created.id}`,
      headers: auth(),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.id).toBe(created.id);
  });

  it('rejects a duplicate slug with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: auth(),
      payload: { slug: 'rtest-leeds', name: 'Leeds Again' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects an invalid (non-kebab) slug with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: auth(),
      payload: { slug: 'Rtest Leeds', name: 'Bad' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a USD/imperial site and updates it', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: auth(),
      payload: {
        slug: 'rtest-bristol',
        name: 'Bristol',
        currencyCode: 'USD',
        uomSystem: 'IMPERIAL',
        timezone: 'America/Chicago',
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().data.id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${id}`,
      headers: auth(),
      payload: { name: 'Bristol Central', isActive: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.name).toBe('Bristol Central');
    expect(patch.json().data.isActive).toBe(false);
    expect(patch.json().data.currencyCode).toBe('USD');
  });
});

// ── F-7: no per-site bench configuration exists (Aug-2026, corrected) ───────
//
// `sites.benches_per_table` shipped on 20 Aug on a misreading of F-7 and was
// dropped the same day (migration 0045). A bench and a table are the same
// thing, so the column was a conversion factor between a thing and itself.
// This asserts it stays gone: re-adding it would put a meaningless field back
// on the Sites page and an "≈ N benches" line back under every quantity.
describe('sites carry no bench ratio', () => {
  it('does not accept or return benchesPerTable', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: 'bench-gone', name: 'Bench Gone', benchesPerTable: 6 },
    });
    expect(created.statusCode).toBe(201);
    // Unknown keys are ignored by the schema, and nothing comes back.
    expect(created.json().data).not.toHaveProperty('benchesPerTable');
  });
});
