/**
 * Finding a product by its code (Aug-2026 feedback set, defect C-3).
 *
 * "Manual barcode entry failed to find the product for an icing sugar
 * delivery." `products` has had a `barcode` column AND a `products_barcode_idx`
 * built for scan-to-find since the item model landed — but the search
 * predicate covered only `name`, `stockCode` and `ean`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { products } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

let app: FastifyInstance;
let token: string;
let icingId: string;
let skittlesId: string;
let namelessId: string;
const COMPANY = getSingletonCompanyId();

const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  token = app.jwt.sign({
    userId: 'bc-test',
    companyId: COMPANY,
    email: 'bc@test.invalid',
    roles: ['admin'],
  });

  const db = getDb();
  const [icing] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'BC Icing sugar',
      slug: 'bc-icing-sugar',
      stockCode: 'BC-ICING',
      barcode: '5012345678900',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
    })
    .returning();
  const [skittles] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'BC Skittles',
      slug: 'bc-skittles',
      stockCode: 'BC-SKITTLE',
      ean: '4009900484220',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
    })
    .returning();
  // A product whose NAME contains the icing barcode — the trap the exact
  // endpoint exists to avoid.
  const [nameless] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'BC Sugar sachets 5012345678900 case',
      slug: 'bc-sugar-sachets',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
    })
    .returning();
  icingId = icing!.id;
  skittlesId = skittles!.id;
  namelessId = nameless!.id;
});

afterAll(async () => {
  const db = getDb();
  for (const id of [icingId, skittlesId, namelessId]) {
    await db.delete(products).where(eq(products.id, id));
  }
  await app.close();
  await closeDatabase();
});

async function search(term: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/products',
    headers: auth(),
    query: { search: term },
  });
  return res.json().data as Array<{ id: string; name: string }>;
}

describe('GET /products?search — the predicate covers barcode (C-3)', () => {
  it('C-3 REGRESSION: finds a product by its full barcode', async () => {
    const found = await search('5012345678900');
    expect(found.map((p) => p.id)).toContain(icingId);
  });

  it('finds a product by a partial barcode', async () => {
    const found = await search('50123456');
    expect(found.map((p) => p.id)).toContain(icingId);
  });

  it('still finds by EAN', async () => {
    const found = await search('4009900484220');
    expect(found.map((p) => p.id)).toContain(skittlesId);
  });

  it('still finds by stock code', async () => {
    const found = await search('BC-SKITTLE');
    expect(found.map((p) => p.id)).toContain(skittlesId);
  });

  it('still finds by name', async () => {
    const found = await search('BC Icing');
    expect(found.map((p) => p.id)).toContain(icingId);
  });
});

describe('GET /products/by-code/:code — one answer or none (C-3)', () => {
  it('C-3: an exact barcode outranks a name that merely contains it', async () => {
    // Both products match a plain search; the scan must resolve to the one
    // that CARRIES the code, not the one that mentions it.
    const both = await search('5012345678900');
    expect(both.map((p) => p.id)).toEqual(expect.arrayContaining([icingId, namelessId]));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products/by-code/5012345678900',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(icingId);
  });

  it('resolves an EAN when no barcode carries the code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products/by-code/4009900484220',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(skittlesId);
  });

  it('resolves a stock code typed off a shelf label, case-insensitively', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products/by-code/bc-icing',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(icingId);
  });

  it('404s on a genuine miss, naming the code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products/by-code/0000000000000',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('0000000000000');
  });
});

describe('POST /products/:id/barcode — attach a code (C-3)', () => {
  it('persists, and the product is then findable by that code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${namelessId}/barcode`,
      headers: auth(),
      payload: { barcode: '7777777777777' },
    });
    expect(res.statusCode).toBe(200);

    const found = await app.inject({
      method: 'GET',
      url: '/api/v1/products/by-code/7777777777777',
      headers: auth(),
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().data.id).toBe(namelessId);
  });

  it('C-3: a code already on another product is a CONFLICT, not a silent overwrite', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${skittlesId}/barcode`,
      headers: auth(),
      payload: { barcode: '5012345678900' }, // icing sugar's
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/BC Icing sugar/);

    // And the icing sugar still owns it — a silent steal would send the NEXT
    // scan of this code to the wrong product.
    const still = await app.inject({
      method: 'GET',
      url: '/api/v1/products/by-code/5012345678900',
      headers: auth(),
    });
    expect(still.json().data.id).toBe(icingId);
  });

  it('re-attaching a product its own code is a no-op, not a conflict', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${icingId}/barcode`,
      headers: auth(),
      payload: { barcode: '5012345678900' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an empty barcode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${icingId}/barcode`,
      headers: auth(),
      payload: { barcode: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });
});
