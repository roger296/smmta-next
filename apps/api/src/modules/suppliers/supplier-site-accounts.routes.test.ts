/**
 * Supplier accounts per venue (supplier-ordering groundwork). Real Postgres +
 * the built app.
 *
 * Covers: every venue is listed, with or without an account; head office can
 * create and partly update one; the next delivery is worked out from it; a
 * venue manager cannot change one; bad days, times and ids are refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { sites, suppliers, supplierSiteAccounts } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

const COMPANY = getSingletonCompanyId();
let app: FastifyInstance;
let admin: string;
let manager: string;
let supplierId: string;
let eastId: string;
let southId: string;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.delete(suppliers).where(eq(suppliers.name, 'SSA Test Brakes'));
  await db.delete(sites).where(inArray(sites.slug, ['ssa-east', 'ssa-south']));
}

const call = (method: 'GET' | 'PUT', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as object });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  admin = app.jwt.sign({ userId: 'ssa-admin', companyId: COMPANY, email: 'a@ssa.invalid', roles: ['admin'] });
  manager = app.jwt.sign({ userId: 'ssa-mgr', companyId: COMPANY, email: 'm@ssa.invalid', roles: ['site_manager'] });

  await cleanup();
  const db = getDb();
  const [sup] = await db.insert(suppliers).values({ companyId: COMPANY, name: 'SSA Test Brakes' }).returning();
  supplierId = sup!.id;
  const [e] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'ssa-east', name: 'SSA East', canonicalName: 'SSA East' })
    .returning();
  const [s] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'ssa-south', name: 'SSA South', canonicalName: 'SSA South' })
    .returning();
  eastId = e!.id;
  southId = s!.id;
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

type View = { site: { id: string }; account: Record<string, unknown> | null; nextDelivery: Record<string, unknown> | null };
const mine = async (): Promise<View[]> => {
  const res = await call('GET', `/suppliers/${supplierId}/site-accounts`, admin);
  expect(res.statusCode).toBe(200);
  return (res.json().data as View[]).filter((v) => [eastId, southId].includes(v.site.id));
};

describe('supplier site accounts', () => {
  it('lists every venue, with no account yet', async () => {
    const views = await mine();
    expect(views).toHaveLength(2);
    expect(views.every((v) => v.account === null && v.nextDelivery === null)).toBe(true);
  });

  it('head office records a round, and the next delivery is worked out from it', async () => {
    const res = await call('PUT', `/suppliers/${supplierId}/site-accounts/${eastId}`, admin, {
      accountNumber: 'BR-104233',
      deliveryDays: ['tue', 'THU'],
      cutoffTime: '16:00',
      cutoffDaysBefore: 1,
      minOrderValue: 150,
      deliveryCharge: 12.5,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      accountNumber: 'BR-104233',
      deliveryDays: ['TUE', 'THU'],
      cutoffTime: '16:00:00',
      minOrderValue: '150.00',
      deliveryCharge: '12.50',
      isActive: true,
    });

    const east = (await mine()).find((v) => v.site.id === eastId)!;
    expect(east.nextDelivery).toMatchObject({ basis: 'ROUND' });
    expect(['TUE', 'THU']).toContain(
      ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(`${east.nextDelivery!.deliveryDate}T12:00:00Z`).getUTCDay()],
    );
  });

  it('a partial update leaves other fields alone, and null clears one', async () => {
    await call('PUT', `/suppliers/${supplierId}/site-accounts/${eastId}`, admin, {
      deliveryCharge: null,
      notes: 'Rear entrance before 9am',
    });
    const row = await getDb().query.supplierSiteAccounts.findFirst({
      where: (a, { and, eq: e }) => and(e(a.supplierId, supplierId), e(a.siteId, eastId)),
    });
    expect(row).toMatchObject({
      accountNumber: 'BR-104233',
      deliveryCharge: null,
      minOrderValue: '150.00',
      notes: 'Rear entrance before 9am',
    });
  });

  it('switching an account off stops it being dated', async () => {
    await call('PUT', `/suppliers/${supplierId}/site-accounts/${eastId}`, admin, { isActive: false });
    expect((await mine()).find((v) => v.site.id === eastId)!.nextDelivery).toBeNull();
    await call('PUT', `/suppliers/${supplierId}/site-accounts/${eastId}`, admin, { isActive: true });
  });

  it('a venue manager cannot change an account', async () => {
    const res = await call('PUT', `/suppliers/${supplierId}/site-accounts/${southId}`, manager, { leadDays: 1 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/an admin/);
    const rows = await getDb().select().from(supplierSiteAccounts).where(eq(supplierSiteAccounts.siteId, southId));
    expect(rows).toHaveLength(0);
  });

  it.each([
    [{ deliveryDays: ['TUES'] }, /deliveryDays/],
    [{ cutoffTime: '4pm' }, /24-hour time/],
    [{ cutoffDaysBefore: 30 }, /cutoffDaysBefore/],
    [{ minOrderValue: -1 }, /minOrderValue/],
    [{ somethingElse: 1 }, /Unrecognized key/i],
  ])('refuses %j', async (body, message) => {
    const res = await call('PUT', `/suppliers/${supplierId}/site-accounts/${southId}`, admin, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(message);
  });

  it('404s an unknown supplier or site', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect((await call('PUT', `/suppliers/${ghost}/site-accounts/${southId}`, admin, { leadDays: 1 })).statusCode).toBe(404);
    expect((await call('PUT', `/suppliers/${supplierId}/site-accounts/${ghost}`, admin, { leadDays: 1 })).statusCode).toBe(404);
  });
});
