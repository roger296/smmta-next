/**
 * Integration tests for /api/v1/admin/api-keys + the apiKeyAuth middleware.
 *
 * Flow exercised:
 *   1. operator issues a key via JWT-gated admin route → raw key returned
 *      exactly once
 *   2. the raw key authenticates against a test route gated by apiKeyAuth
 *      with scope `storefront:read` → 200
 *   3. listing keys never exposes `keyHash` or the raw value
 *   4. issuing a key with an insufficient scope returns 403 from the
 *      gated test route
 *   5. revoking a key causes the same call to return 401
 *   6. the gated route returns 401 with `WWW-Authenticate: Bearer` when
 *      the bearer is missing or malformed
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { apiKeys } from '../../db/schema/index.js';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';

const TEST_COMPANY_ID = '44444444-4444-4444-8444-444444444444';

let app: FastifyInstance;
let jwt: string;

async function issueKey(name: string, scopes: string[]): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/api-keys',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name, scopes },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { data: { id: string; key: string } };
  return body.data.key;
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();

  // Add a tiny test-only route to verify the middleware end-to-end.
  app.register(
    async (instance) => {
      instance.get(
        '/__test__/storefront-read',
        { preHandler: apiKeyAuth(['storefront:read']) },
        async (request) => ({
          ok: true,
          companyId: request.apiKey?.companyId,
          scopes: request.apiKey?.scopes,
        }),
      );
    },
    { prefix: '/api/v1' },
  );

  await app.ready();

  jwt = app.jwt.sign({
    userId: 'operator',
    companyId: TEST_COMPANY_ID,
    email: 'op@example.com',
    roles: ['admin'],
  });
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

beforeEach(async () => {
  // Clean slate per test for the test company.
  const db = getDb();
  await db.delete(apiKeys).where(eq(apiKeys.companyId, TEST_COMPANY_ID));
});

describe('POST /admin/api-keys (issue)', () => {
  it('returns the raw key exactly once and never exposes the hash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/api-keys',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'web-store-test', scopes: ['storefront:read'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown> & {
      data: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    expect(body.data.key).toMatch(/^smmta_[0-9a-f]{8}_[0-9a-f]{32}$/);
    expect(body.data.prefix).toMatch(/^[0-9a-f]{8}$/);
    expect((body.data.key as string).startsWith(`smmta_${body.data.prefix}_`)).toBe(true);
    // Hash must never be in the response.
    expect(body.data.keyHash).toBeUndefined();
    expect(body.data.key_hash).toBeUndefined();
  });

  it('rejects duplicate names within a company with 409', async () => {
    await issueKey('dup-name', ['storefront:read']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/api-keys',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'dup-name', scopes: ['storefront:read'] },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/api-keys',
      payload: { name: 'no-auth', scopes: [] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /admin/api-keys (list)', () => {
  it('lists live keys without the hash and without the raw key', async () => {
    await issueKey('list-test', ['storefront:read']);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/api-keys',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data.length).toBe(1);
    const [row] = body.data;
    expect(row?.name).toBe('list-test');
    expect(row?.prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(row?.keyHash).toBeUndefined();
    expect(row?.key_hash).toBeUndefined();
    expect(row?.key).toBeUndefined(); // raw is never returned outside POST
  });
});

describe('apiKeyAuth middleware (end-to-end)', () => {
  it('200 with a valid key that has the required scope', async () => {
    const raw = await issueKey('e2e-good', ['storefront:read']);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/__test__/storefront-read',
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; companyId: string; scopes: string[] };
    expect(body.ok).toBe(true);
    expect(body.companyId).toBe(TEST_COMPANY_ID);
    expect(body.scopes).toContain('storefront:read');
  });

  it('403 when scopes are insufficient', async () => {
    const raw = await issueKey('e2e-no-scope', []); // no scopes
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/__test__/storefront-read',
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('401 with WWW-Authenticate after the key is revoked', async () => {
    // Issue a key, find its id, revoke it.
    const issueRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/api-keys',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'e2e-revoke', scopes: ['storefront:read'] },
    });
    const issued = issueRes.json() as { data: { id: string; key: string } };
    const raw = issued.data.key;

    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/api-keys/${issued.data.id}/revoke`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect((revokeRes.json() as { data: { revokedAt: string } }).data.revokedAt).toBeTruthy();

    const callRes = await app.inject({
      method: 'GET',
      url: '/api/v1/__test__/storefront-read',
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(callRes.statusCode).toBe(401);
    expect(callRes.headers['www-authenticate']).toBe('Bearer');
  });

  it('401 with WWW-Authenticate when no Authorization header is sent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/__test__/storefront-read',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('401 with a malformed Bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/__test__/storefront-read',
      headers: { authorization: 'Bearer not-a-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('401 with a syntactically valid but unknown key', async () => {
    // 8 hex prefix + 32 hex secret, but never persisted.
    const fakeRaw = 'smmta_deadbeef_' + '0'.repeat(32);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/__test__/storefront-read',
      headers: { authorization: `Bearer ${fakeRaw}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 when the prefix exists but the secret is wrong', async () => {
    const raw = await issueKey('e2e-wrong-secret', ['storefront:read']);
    // Take the prefix from the issued key but mangle the secret.
    const m = /^smmta_([0-9a-f]{8})_([0-9a-f]{32})$/.exec(raw);
    expect(m).not.toBeNull();
    const wrong = `smmta_${m![1]}_${'a'.repeat(32)}`;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/__test__/storefront-read',
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /admin/api-keys/:id/revoke', () => {
  it('revokes a live key and returns 404 for unknown ids', async () => {
    const issued = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/api-keys',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'to-revoke', scopes: ['storefront:read'] },
    });
    const id = (issued.json() as { data: { id: string } }).data.id;

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/api-keys/${id}/revoke`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(ok.statusCode).toBe(200);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/api-keys/00000000-0000-4000-8000-000000000000/revoke`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});
