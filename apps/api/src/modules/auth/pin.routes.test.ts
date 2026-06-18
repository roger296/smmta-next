/**
 * Shared-device PIN login (P12, spec §A11). Real Postgres + the built app.
 *
 * Proves: a valid PIN issues a JWT scoped to the right roles + site; a wrong
 * PIN is 401; creating a PIN requires auth.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { devicePins, sites } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { hashPassword } from '../../shared/auth/password.js';

const COMPANY = getSingletonCompanyId();
let app: FastifyInstance;
let jwt: string;
let siteId: string;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.delete(devicePins).where(eq(devicePins.label, 'PWA Test Baker'));
  await db.delete(sites).where(eq(sites.slug, 'pwa-test-site'));
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  jwt = app.jwt.sign({ userId: 'u', companyId: COMPANY, email: 't@a.invalid', roles: ['admin'] });
  await cleanup();
  const [s] = await getDb()
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'pwa-test-site', name: 'PWA Test', canonicalName: 'PWA Test' })
    .returning();
  siteId = s!.id;
  await getDb().insert(devicePins).values({
    companyId: COMPANY,
    siteId,
    label: 'PWA Test Baker',
    pinHash: await hashPassword('4821'),
    roles: ['head_baker'],
  });
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

describe('POST /auth/pin-login', () => {
  it('issues a JWT scoped to the right roles + site for a valid PIN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-login',
      payload: { pin: '4821', siteId },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.user.label).toBe('PWA Test Baker');
    expect(data.user.roles).toEqual(['head_baker']);
    expect(data.user.siteId).toBe(siteId);

    // The token carries the scoped claims.
    const decoded = app.jwt.verify(data.token) as { roles: string[]; siteId: string };
    expect(decoded.roles).toEqual(['head_baker']);
    expect(decoded.siteId).toBe(siteId);
  });

  it('rejects a wrong PIN with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin-login',
      payload: { pin: '0000', siteId },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /device-pins', () => {
  it('requires auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/device-pins',
      payload: { label: 'x', pin: '1234' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a PIN for an authenticated admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/device-pins',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { label: 'PWA Test Baker', pin: '9999', siteId, roles: ['head_baker'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.label).toBe('PWA Test Baker');
  });
});
