/**
 * Two counters, one take, two iPads (Sept 2026). Real Postgres + the built app.
 *
 * Plays out the venue scenario through the HTTP routes with genuinely signed
 * tokens, because the point under test is that the NAME on a count comes from
 * the sign-in, not from anything the client sends:
 *
 *   Sam opens a count → Alex finds it in the open list and joins it → each saves
 *   different lines → either one reading the take sees both, each attributed →
 *   once a manager approves, a late save is refused with a 409 rather than kept
 *   and never used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  products,
  sites,
  stockLevels,
  stockMovements,
  stockTakeLines,
  stockTakes,
  users,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

const COMPANY = getSingletonCompanyId();
const MANAGER_ID = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
let app: FastifyInstance;
let siteId: string;
let flourId: string;
let sugarId: string;
let sam: string;
let alex: string;
let manager: string;

async function cleanup(): Promise<void> {
  const db = getDb();
  const site = await db.query.sites.findFirst({ where: eq(sites.slug, 'stmu-site') });
  if (site) {
    const takes = await db.select({ id: stockTakes.id }).from(stockTakes).where(eq(stockTakes.siteId, site.id));
    if (takes.length) {
      await db.delete(stockTakeLines).where(inArray(stockTakeLines.stockTakeId, takes.map((t) => t.id)));
      await db.delete(stockTakes).where(eq(stockTakes.siteId, site.id));
    }
    await db.delete(stockMovements).where(eq(stockMovements.siteId, site.id));
    await db.delete(stockLevels).where(eq(stockLevels.siteId, site.id));
    await db.delete(sites).where(eq(sites.id, site.id));
  }
  await db.delete(products).where(inArray(products.slug, ['stmu-flour', 'stmu-sugar']));
  await db.delete(users).where(eq(users.id, MANAGER_ID));
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  await cleanup();
  const db = getDb();
  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'stmu-site', name: 'STMU Venue', canonicalName: 'STMU Venue' })
    .returning();
  siteId = site!.id;
  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'STMU Flour', slug: 'stmu-flour', itemKind: 'INGREDIENT', stockUom: 'kg' })
    .returning();
  const [s] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'STMU Sugar', slug: 'stmu-sugar', itemKind: 'INGREDIENT', stockUom: 'kg' })
    .returning();
  flourId = f!.id;
  sugarId = s!.id;
  await db.insert(stockLevels).values([
    { companyId: COMPANY, productId: flourId, siteId, onHand: '10' },
    { companyId: COMPANY, productId: sugarId, siteId, onHand: '4' },
  ]);
  await db.insert(users).values({
    id: MANAGER_ID,
    companyId: COMPANY,
    email: 'stmu-manager@example.invalid',
    passwordHash: 'x:y',
    name: 'Morgan Manager',
    roles: ['site_manager'],
  });

  // PIN tokens exactly as /auth/pin-login signs them: `pin:<id>`, the person's
  // name as `label`, scoped to the venue.
  const pinToken = (id: string, label: string) =>
    app.jwt.sign({
      userId: `pin:${id}`,
      companyId: COMPANY,
      email: `${label}@pin.local`,
      roles: ['head_baker'],
      siteId,
      siteIds: [siteId],
      label,
    });
  sam = pinToken('11111111-aaaa-4aaa-8aaa-111111111111', 'Sam');
  alex = pinToken('22222222-bbbb-4bbb-8bbb-222222222222', 'Alex');
  // An email sign-in carries no name; it must be looked up.
  manager = app.jwt.sign({
    userId: MANAGER_ID,
    companyId: COMPANY,
    email: 'stmu-manager@example.invalid',
    roles: ['site_manager'],
  });
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

describe('two counters sharing one take', () => {
  let takeId: string;

  it('Sam opens a count, and it records Sam as the opener', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-takes',
      headers: auth(sam),
      payload: { siteId, scope: 'FULL' },
    });
    expect(res.statusCode).toBe(201);
    takeId = res.json().data.take.id;
    expect(res.json().data.take.openedByName).toBe('Sam');
  });

  it("Alex finds Sam's count in the venue's open list, with its progress", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-takes?siteId=${siteId}&status=OPEN`,
      headers: auth(alex),
    });
    expect(res.statusCode).toBe(200);
    const [row] = res.json().data;
    expect(row.id).toBe(takeId);
    expect(row.openedByName).toBe('Sam');
    expect(row.lineCount).toBe(2);
    expect(row.countedCount).toBe(0);
  });

  it('each saves different lines, and the name comes from the sign-in', async () => {
    const a = await app.inject({
      method: 'POST',
      url: `/api/v1/stock-takes/${takeId}/counts`,
      headers: auth(sam),
      payload: { counts: [{ productId: flourId, countedQty: 10 }] },
    });
    const b = await app.inject({
      method: 'POST',
      url: `/api/v1/stock-takes/${takeId}/counts`,
      headers: auth(alex),
      // A name in the body is not a thing the API reads — it must be ignored.
      payload: { counts: [{ productId: sugarId, countedQty: 4 }], countedByName: 'Not Alex' },
    });
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  });

  it("either counter reading the take sees both counts, each with its counter's name", async () => {
    for (const token of [sam, alex]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/stock-takes/${takeId}`, headers: auth(token) });
      const lines = res.json().data.lines as Array<{ productId: string; countedQty: string; countedByName: string; countedByUserId: string }>;
      const flour = lines.find((l) => l.productId === flourId)!;
      const sugar = lines.find((l) => l.productId === sugarId)!;
      expect([Number(flour.countedQty), flour.countedByName]).toEqual([10, 'Sam']);
      expect([Number(sugar.countedQty), sugar.countedByName]).toEqual([4, 'Alex']);
      expect(sugar.countedByUserId).toBe('pin:22222222-bbbb-4bbb-8bbb-222222222222');
    }
  });

  it('the open list now names both counters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-takes?siteId=${siteId}&status=OPEN`,
      headers: auth(sam),
    });
    const [row] = res.json().data;
    expect(row.countedCount).toBe(2);
    expect(row.counters).toEqual(['Alex', 'Sam']);
  });

  it('an email sign-in is named from the users table, not by its email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stock-takes/${takeId}/counts`,
      headers: auth(manager),
      payload: { counts: [{ productId: sugarId, countedQty: 4 }] },
    });
    expect(res.statusCode).toBe(200);
    const got = await app.inject({ method: 'GET', url: `/api/v1/stock-takes/${takeId}`, headers: auth(sam) });
    const sugar = (got.json().data.lines as Array<{ productId: string; countedByName: string }>).find(
      (l) => l.productId === sugarId,
    )!;
    expect(sugar.countedByName).toBe('Morgan Manager');
  });

  it('after approval, a late save is refused with a 409 that says why', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/stock-takes/${takeId}/approve`,
      headers: auth(manager),
    });
    expect(ok.statusCode).toBe(200);
    const late = await app.inject({
      method: 'POST',
      url: `/api/v1/stock-takes/${takeId}/counts`,
      headers: auth(alex),
      payload: { counts: [{ productId: flourId, countedQty: 1 }] },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toMatch(/already been approved/);
  });
});
