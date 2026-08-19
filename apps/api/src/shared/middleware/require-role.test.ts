/**
 * Role + site guards, end to end over the real routes (Aug-2026, E-1 / E-4).
 *
 * "Accidental booking logged 100kg to Birmingham; requested an undo timer or
 * role-based permission locks." There was no role guard beside `requireAuth`
 * at all, and a PIN bound to one site could name any other in the body.
 *
 * The matrix below is every guarded route × every role, because a permission
 * model asserted only on its happy path is a permission model nobody can trust.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  goodsInReceiptLines,
  goodsInReceipts,
  products,
  sites,
  stockLevels,
  stockMovements,
  stockTakeLines,
  stockTakes,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { hasRole } from './require-role.js';

let app: FastifyInstance;
let londonSouthId: string;
let birminghamId: string;
let productId: string;
const COMPANY = getSingletonCompanyId();

/** A PIN-style token: scoped to a site, carrying roles. */
function pinToken(roles: string[], siteId: string | null): string {
  return app.jwt.sign({
    userId: `pin:test-${roles.join('-')}`,
    companyId: COMPANY,
    email: 'pin@test.invalid',
    roles,
    siteId,
    label: 'Test device',
  });
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();

  const db = getDb();
  const [ls] = await db
    .insert(sites)
    .values({
      companyId: COMPANY,
      slug: 'rg-london-south',
      name: 'RG London South',
      canonicalName: 'RG London South',
    })
    .returning();
  const [bh] = await db
    .insert(sites)
    .values({
      companyId: COMPANY,
      slug: 'rg-birmingham',
      name: 'RG Birmingham',
      canonicalName: 'RG Birmingham',
    })
    .returning();
  londonSouthId = ls!.id;
  birminghamId = bh!.id;

  const [p] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'RG Icing sugar',
      slug: 'rg-icing-sugar',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
      purchaseUom: 'sack',
      purchaseToStockFactor: '25000',
      expectedNextCost: '0.0012',
    })
    .returning();
  productId = p!.id;
});

afterAll(async () => {
  const db = getDb();
  for (const siteId of [londonSouthId, birminghamId]) {
    const receipts = await db
      .select({ id: goodsInReceipts.id })
      .from(goodsInReceipts)
      .where(eq(goodsInReceipts.siteId, siteId));
    for (const r of receipts) {
      await db.delete(goodsInReceiptLines).where(eq(goodsInReceiptLines.receiptId, r.id));
    }
    await db.delete(goodsInReceipts).where(eq(goodsInReceipts.siteId, siteId));
    const takes = await db
      .select({ id: stockTakes.id })
      .from(stockTakes)
      .where(eq(stockTakes.siteId, siteId));
    for (const t of takes) {
      await db.delete(stockTakeLines).where(eq(stockTakeLines.stockTakeId, t.id));
    }
    await db.delete(stockTakes).where(eq(stockTakes.siteId, siteId));
    await db.delete(stockMovements).where(eq(stockMovements.siteId, siteId));
    await db.delete(stockLevels).where(eq(stockLevels.siteId, siteId));
  }
  await db.delete(products).where(eq(products.id, productId));
  await db.delete(sites).where(eq(sites.id, londonSouthId));
  await db.delete(sites).where(eq(sites.id, birminghamId));
  await app.close();
  await closeDatabase();
});

let keySeq = 0;
const nextKey = () => `rg-${Date.now()}-${keySeq++}`;

function bookingBody(siteId: string) {
  return {
    siteId,
    idempotencyKey: nextKey(),
    lines: [{ productId, qtyPurchase: 4, unitCost: 30 }],
  };
}

describe('hasRole', () => {
  it('admin passes every guard without being named in it', () => {
    expect(hasRole({ roles: ['admin'] }, ['site_manager'])).toBe(true);
    expect(hasRole({ roles: ['admin'] }, ['head_baker'])).toBe(true);
  });

  it('matches any of the allowed roles', () => {
    expect(hasRole({ roles: ['head_baker'] }, ['head_baker', 'site_manager'])).toBe(true);
    expect(hasRole({ roles: ['site_manager'] }, ['head_baker', 'site_manager'])).toBe(true);
  });

  it('rejects a role that is not allowed, and an empty role list', () => {
    expect(hasRole({ roles: ['head_baker'] }, ['site_manager'])).toBe(false);
    expect(hasRole({ roles: [] }, ['head_baker'])).toBe(false);
  });
});

// ── The matrix: every guarded route × every role ────────────────────────────
describe('E-4: role matrix over the guarded routes', () => {
  const ROLES = ['head_baker', 'site_manager', 'admin'] as const;

  it.each(ROLES)('POST /goods-in — %s may book in', async (role) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(pinToken([role], londonSouthId)),
      payload: bookingBody(londonSouthId),
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST /goods-in — a role with no permissions is refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(pinToken(['viewer'], londonSouthId)),
      payload: bookingBody(londonSouthId),
    });
    expect(res.statusCode).toBe(403);
    // The message names the roles that WOULD work — it is surfaced to a baker
    // through the error banner, and "not allowed" alone is a dead end.
    expect(res.json().error).toMatch(/head baker|site manager/i);
  });

  it('POST /goods-in/:id/reverse — head_baker is refused, site_manager allowed', async () => {
    const booked = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(pinToken(['site_manager'], londonSouthId)),
      payload: bookingBody(londonSouthId),
    });
    const receiptId = booked.json().data.receipt.id as string;

    const asBaker = await app.inject({
      method: 'POST',
      url: `/api/v1/goods-in/${receiptId}/reverse`,
      headers: auth(pinToken(['head_baker'], londonSouthId)),
      payload: {},
    });
    expect(asBaker.statusCode).toBe(403);

    const asManager = await app.inject({
      method: 'POST',
      url: `/api/v1/goods-in/${receiptId}/reverse`,
      headers: auth(pinToken(['site_manager'], londonSouthId)),
      payload: { reason: 'Wrong venue' },
    });
    expect(asManager.statusCode).toBe(201);
  });

  it('POST /stock-takes/:id/approve — head_baker is refused, site_manager allowed', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-takes',
      headers: auth(pinToken(['head_baker'], londonSouthId)),
      payload: { siteId: londonSouthId, scope: 'FULL' },
    });
    expect(opened.statusCode).toBe(201);
    const takeId = opened.json().data.take.id as string;

    const asBaker = await app.inject({
      method: 'POST',
      url: `/api/v1/stock-takes/${takeId}/approve`,
      headers: auth(pinToken(['head_baker'], londonSouthId)),
    });
    expect(asBaker.statusCode).toBe(403);

    const asManager = await app.inject({
      method: 'POST',
      url: `/api/v1/stock-takes/${takeId}/approve`,
      headers: auth(pinToken(['site_manager'], londonSouthId)),
    });
    expect(asManager.statusCode).toBe(200);
  });

  it('PUT /products/:id — a head_baker cannot change a cost', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${productId}`,
      headers: auth(pinToken(['head_baker'], londonSouthId)),
      payload: { name: 'RG Icing sugar', expectedNextCost: 0.002 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/site manager/i);
  });

  it('PUT /products/:id — a head_baker CAN edit a product without touching the cost', async () => {
    // The guard is on the field, not the route: gating the whole route would
    // block work the role should do, to protect one field. (It also proves
    // `.partial()` does not apply createProductSchema's cost default, which
    // would 403 every ordinary edit.)
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${productId}`,
      headers: auth(pinToken(['head_baker'], londonSouthId)),
      payload: { packDescription: '25 kg sack' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.packDescription).toBe('25 kg sack');
  });

  it('PUT /products/:id — a site_manager can', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${productId}`,
      headers: auth(pinToken(['site_manager'], londonSouthId)),
      payload: { name: 'RG Icing sugar', expectedNextCost: 0.0012 },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── E-1: the named regression ───────────────────────────────────────────────
describe('E-1: a PIN bound to London South cannot book to Birmingham', () => {
  it('E-1 REGRESSION: head_baker bound to London South, body naming Birmingham → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(pinToken(['head_baker'], londonSouthId)),
      payload: bookingBody(birminghamId),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/different venue/i);

    // And nothing was written to Birmingham.
    const receipts = await getDb()
      .select({ id: goodsInReceipts.id })
      .from(goodsInReceipts)
      .where(eq(goodsInReceipts.siteId, birminghamId));
    expect(receipts).toHaveLength(0);
  });

  it('the same booking to its OWN site succeeds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(pinToken(['head_baker'], londonSouthId)),
      payload: bookingBody(londonSouthId),
    });
    expect(res.statusCode).toBe(201);
  });

  it('a site_manager MAY cross sites — someone has to be able to fix a mis-booking', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(pinToken(['site_manager'], londonSouthId)),
      payload: bookingBody(birminghamId),
    });
    expect(res.statusCode).toBe(201);
  });

  it('an unscoped token (a desk login) is site-agnostic by design', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(pinToken(['head_baker'], null)),
      payload: bookingBody(birminghamId),
    });
    expect(res.statusCode).toBe(201);
  });

  it('the same guard covers opening a stock-take', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-takes',
      headers: auth(pinToken(['head_baker'], londonSouthId)),
      payload: { siteId: birminghamId, scope: 'FULL' },
    });
    expect(res.statusCode).toBe(403);
  });
});
