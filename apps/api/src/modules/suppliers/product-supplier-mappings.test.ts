/**
 * Product → supplier mappings: several suppliers per product, and several of
 * ONE supplier's codes per product.
 *
 * `supplier_products` is unique on (product, supplier, supplier_sku) precisely
 * because a supplier lists the same item under more than one code and pack
 * size — Brakes sells one item as 20954 and A20954, Booker sells Absolut as
 * 318639 and 503510. The reorder engine compares those alternatives, so losing
 * one is not cosmetic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { products, supplierProducts, suppliers } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

const COMPANY = getSingletonCompanyId();
const PREFIX = 'MAPTEST';

let app: FastifyInstance;
let jwt: string;
let productId: string;
let brakesId: string;
let bookerId: string;

async function wipe() {
  const db = getDb();
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.stockCode, `${PREFIX}-001`));
  for (const p of ps) {
    await db.delete(supplierProducts).where(eq(supplierProducts.productId, p.id));
    await db.delete(products).where(eq(products.id, p.id));
  }
  const ss = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(inArray(suppliers.slug, [`${PREFIX}-brakes`, `${PREFIX}-booker`]));
  for (const s of ss) {
    await db.delete(supplierProducts).where(eq(supplierProducts.supplierId, s.id));
    await db.delete(suppliers).where(eq(suppliers.id, s.id));
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  jwt = app.jwt.sign({
    userId: 'test-op',
    companyId: COMPANY,
    email: 'op@test.invalid',
    roles: ['admin'],
  });
});

beforeEach(async () => {
  await wipe();
  const db = getDb();
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Map Test Flour', stockCode: `${PREFIX}-001`, stockUom: 'g' })
    .returning();
  productId = p!.id;
  const [b1] = await db
    .insert(suppliers)
    .values({ companyId: COMPANY, name: 'Map Test Brakes', slug: `${PREFIX}-brakes` })
    .returning();
  brakesId = b1!.id;
  const [b2] = await db
    .insert(suppliers)
    .values({ companyId: COMPANY, name: 'Map Test Booker', slug: `${PREFIX}-booker` })
    .returning();
  bookerId = b2!.id;
});

afterAll(async () => {
  if (app) await app.close();
  await wipe();
  await closeDatabase();
});

function put(mappings: unknown[]) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/products/${productId}/supplier-mappings`,
    headers: { authorization: `Bearer ${jwt}` },
    payload: { mappings },
  });
}

function get() {
  return app.inject({
    method: 'GET',
    url: `/api/v1/products/${productId}/supplier-mappings`,
    headers: { authorization: `Bearer ${jwt}` },
  });
}

interface Mapping {
  id: string;
  supplierId: string;
  supplierSku: string;
  costGbp: string | null;
  priority: number;
  isActive: boolean;
  supplierPackSize: string | null;
}

describe('several suppliers for one product', () => {
  it('stores a mapping per supplier', async () => {
    const res = await put([
      { supplierId: brakesId, supplierSku: '20954', costGbp: '12.50', priority: 1 },
      { supplierId: bookerId, supplierSku: '318639', costGbp: '13.10', priority: 2 },
    ]);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Mapping[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.supplierSku).sort()).toEqual(['20954', '318639']);
  });
});

// THE ONE THAT MATTERS — the table allows it, the write path must too.
describe('several codes from ONE supplier', () => {
  it('keeps every SKU when a supplier lists the item more than once', async () => {
    const res = await put([
      { supplierId: brakesId, supplierSku: '20954', costGbp: '12.50', priority: 1 },
      { supplierId: brakesId, supplierSku: 'A20954', costGbp: '11.80', priority: 2 },
    ]);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Mapping[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.supplierSku).sort()).toEqual(['20954', 'A20954']);
  });

  it('keeps each SKU\'s own cost and pack size', async () => {
    await put([
      { supplierId: brakesId, supplierSku: '20954', costGbp: '12.50', supplierPackSize: 16 },
      { supplierId: brakesId, supplierSku: 'A20954', costGbp: '18.40', supplierPackSize: 25 },
    ]);
    const rows = (await get()).json().data as Mapping[];
    const small = rows.find((r) => r.supplierSku === '20954')!;
    const big = rows.find((r) => r.supplierSku === 'A20954')!;
    expect(Number(small.costGbp)).toBe(12.5);
    expect(Number(small.supplierPackSize)).toBe(16);
    expect(Number(big.costGbp)).toBe(18.4);
    expect(Number(big.supplierPackSize)).toBe(25);
  });

  it('updates one SKU without disturbing the other', async () => {
    await put([
      { supplierId: brakesId, supplierSku: '20954', costGbp: '12.50' },
      { supplierId: brakesId, supplierSku: 'A20954', costGbp: '18.40' },
    ]);
    await put([
      { supplierId: brakesId, supplierSku: '20954', costGbp: '13.00' },
      { supplierId: brakesId, supplierSku: 'A20954', costGbp: '18.40' },
    ]);
    const rows = (await get()).json().data as Mapping[];
    expect(rows).toHaveLength(2);
    expect(Number(rows.find((r) => r.supplierSku === '20954')!.costGbp)).toBe(13);
    expect(Number(rows.find((r) => r.supplierSku === 'A20954')!.costGbp)).toBe(18.4);
  });

  it('removes only the SKU left out of the request', async () => {
    await put([
      { supplierId: brakesId, supplierSku: '20954', costGbp: '12.50' },
      { supplierId: brakesId, supplierSku: 'A20954', costGbp: '18.40' },
    ]);
    await put([{ supplierId: brakesId, supplierSku: '20954', costGbp: '12.50' }]);
    const rows = (await get()).json().data as Mapping[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supplierSku).toBe('20954');
  });

  it('refuses the same supplier + SKU twice in one request', async () => {
    const res = await put([
      { supplierId: brakesId, supplierSku: '20954', costGbp: '12.50' },
      { supplierId: brakesId, supplierSku: '20954', costGbp: '99.00' },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/20954/);
  });
});

describe('a cost you do not know yet', () => {
  // You learn the supplier's code long before you learn their price.
  it('accepts a mapping with no cost', async () => {
    const res = await put([{ supplierId: brakesId, supplierSku: '20954' }]);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Mapping[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costGbp).toBeNull();
  });
});

describe('refusals', () => {
  it('401s without a token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${productId}/supplier-mappings`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('400s on an empty SKU', async () => {
    const res = await put([{ supplierId: brakesId, supplierSku: '' }]);
    expect(res.statusCode).toBe(400);
  });
});
