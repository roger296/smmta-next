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
import { sites } from '../../db/schema/index.js';

const SLUGS = [
  'rtest-leeds',
  'rtest-bristol',
  // F-7 fixtures (Aug-2026 feedback set).
  'bench-default',
  'bench-six',
  'bench-clear',
  'bench-zero',
];
let app: FastifyInstance;
let token: string;

async function cleanup(): Promise<void> {
  await getDb().delete(sites).where(inArray(sites.slug, SLUGS));
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

// ── F-7: benches per table (Aug-2026 feedback set) ──────────────────────────
describe('benchesPerTable', () => {
  it('defaults to NULL — "not set for this site", said out loud rather than assumed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: 'bench-default', name: 'Bench Default' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.benchesPerTable).toBeNull();
  });

  it('F-7: stores and returns a per-site ratio', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: 'bench-six', name: 'Bench Six', benchesPerTable: 6 },
    });
    expect(created.statusCode).toBe(201);
    expect(Number(created.json().data.benchesPerTable)).toBe(6);

    const id = created.json().data.id as string;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { benchesPerTable: 4.5 },
    });
    expect(Number(patched.json().data.benchesPerTable)).toBe(4.5);
  });

  it('null clears it back to "not set"', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: 'bench-clear', name: 'Bench Clear', benchesPerTable: 6 },
    });
    const id = created.json().data.id as string;

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { benchesPerTable: null },
    });
    expect(cleared.json().data.benchesPerTable).toBeNull();
  });

  it('rejects zero — that is a missing answer, not a smaller number of benches', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: 'bench-zero', name: 'Bench Zero', benchesPerTable: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});
