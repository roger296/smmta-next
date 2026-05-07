/**
 * Integration tests for POST /api/v1/auth/login.
 *
 * Uses a real Postgres at DATABASE_URL — same pattern as the api-keys
 * integration tests. Inserts a single throwaway user under the singleton
 * company and exercises happy + sad paths.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { users } from '../../db/schema/index.js';
import { hashPassword } from '../../shared/auth/password.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

let app: FastifyInstance;
const TEST_EMAIL = 'login-test@smmta.invalid';
const TEST_PASSWORD = 'correct-horse-battery-staple';

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  const db = getDb();
  await db.delete(users).where(eq(users.email, TEST_EMAIL));
  await app.close();
  await closeDatabase();
});

beforeEach(async () => {
  const db = getDb();
  await db.delete(users).where(eq(users.email, TEST_EMAIL));
  await db.insert(users).values({
    companyId: getSingletonCompanyId(),
    email: TEST_EMAIL,
    name: 'Login Test',
    passwordHash: await hashPassword(TEST_PASSWORD),
    roles: ['admin'],
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns a token + user shape on valid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: {
        token: string;
        user: { id: string; email: string; name: string; roles: string[] };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.data.user.email).toBe(TEST_EMAIL);
    expect(body.data.user.roles).toEqual(['admin']);
    expect(body.data.user.name).toBe('Login Test');
  });

  it('returned token authenticates against an existing JWT-gated route', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    const token = (login.json() as { data: { token: string } }).data.token;

    const protectedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/api-keys',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(protectedRes.statusCode).toBe(200);
  });

  it('updates lastLoginAt on success', async () => {
    const before = new Date();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    // Best-effort write is fire-and-forget; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const db = getDb();
    const row = await db.query.users.findFirst({ where: eq(users.email, TEST_EMAIL) });
    expect(row?.lastLoginAt).toBeTruthy();
    expect(row!.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('returns 401 with invalid_credentials for the wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'WRONG-PASSWORD' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ success: false, error: 'invalid_credentials' });
  });

  it('returns 401 with the same generic error for an unknown email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody-here@smmta.invalid', password: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ success: false, error: 'invalid_credentials' });
  });

  it('returns 400 on a malformed body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when email or password is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL },
    });
    expect(res.statusCode).toBe(400);
  });
});
