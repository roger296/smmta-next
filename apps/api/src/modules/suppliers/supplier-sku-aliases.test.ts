/**
 * Alternative supplier codes on a mapping.
 *
 * Invoice OCR reads one Brakes line as "33891", "A 33891" and "A33891" across
 * three invoices. All three must FIND the mapping; only "33891" is the code
 * quoted back to Brakes. Aliases are deliberately not extra `supplier_products`
 * rows — those are purchasable lines the reorder engine compares (0052).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { products, supplierProductAliases, supplierProducts, suppliers } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { resolveSupplierSku } from './supplier-sku-resolver.js';

const COMPANY = getSingletonCompanyId();
const PREFIX = 'ALIASTEST';

let app: FastifyInstance;
let jwt: string;
let productId: string;
let brakesId: string;

async function wipe() {
  const db = getDb();
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.stockCode, `${PREFIX}-001`));
  for (const p of ps) {
    const sps = await db.select({ id: supplierProducts.id }).from(supplierProducts).where(eq(supplierProducts.productId, p.id));
    for (const sp of sps) {
      await db.delete(supplierProductAliases).where(eq(supplierProductAliases.supplierProductId, sp.id));
    }
    await db.delete(supplierProducts).where(eq(supplierProducts.productId, p.id));
    await db.delete(products).where(eq(products.id, p.id));
  }
  const ss = await db.select({ id: suppliers.id }).from(suppliers).where(inArray(suppliers.slug, [`${PREFIX}-brakes`]));
  for (const s of ss) {
    await db.delete(supplierProductAliases).where(eq(supplierProductAliases.supplierId, s.id));
    await db.delete(supplierProducts).where(eq(supplierProducts.supplierId, s.id));
    await db.delete(suppliers).where(eq(suppliers.id, s.id));
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  jwt = app.jwt.sign({ userId: 'test-op', companyId: COMPANY, email: 'op@test.invalid', roles: ['admin'] });
});

beforeEach(async () => {
  await wipe();
  const db = getDb();
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Alias Test Flour', stockCode: `${PREFIX}-001`, stockUom: 'kg' })
    .returning();
  productId = p!.id;
  const [b] = await db
    .insert(suppliers)
    .values({ companyId: COMPANY, name: 'Alias Test Brakes', slug: `${PREFIX}-brakes` })
    .returning();
  brakesId = b!.id;
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

interface Mapping {
  id: string;
  supplierSku: string;
  aliases: Array<{ aliasSku: string; source: string }>;
}

describe('storing alternative codes', () => {
  it('keeps the canonical code and its alternatives apart', async () => {
    const res = await put([
      { supplierId: brakesId, supplierSku: '33891', aliases: ['A 33891', 'A33891'] },
    ]);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Mapping[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supplierSku).toBe('33891');
    expect(rows[0]?.aliases.map((a) => a.aliasSku).sort()).toEqual(['A 33891', 'A33891']);
  });

  // The distinction the whole design rests on.
  it('does NOT turn an alias into a second purchasable line', async () => {
    await put([{ supplierId: brakesId, supplierSku: '33891', aliases: ['A33891'] }]);
    const db = getDb();
    const lines = await db
      .select()
      .from(supplierProducts)
      .where(eq(supplierProducts.productId, productId));
    expect(lines).toHaveLength(1);
  });

  it('still allows a genuinely different pack as its own line', async () => {
    const res = await put([
      { supplierId: brakesId, supplierSku: '33891', supplierPackSize: 25, aliases: ['A33891'] },
      { supplierId: brakesId, supplierSku: '114953', supplierPackSize: 9, aliases: ['A114953'] },
    ]);
    const rows = res.json().data as Mapping[];
    expect(rows).toHaveLength(2);
    expect(rows.flatMap((r) => r.aliases.map((a) => a.aliasSku)).sort()).toEqual([
      'A114953',
      'A33891',
    ]);
  });

  it('drops an alias identical to its own canonical code rather than refusing', async () => {
    const res = await put([
      { supplierId: brakesId, supplierSku: '33891', aliases: ['33891', 'A33891'] },
    ]);
    expect(res.statusCode).toBe(200);
    expect((res.json().data as Mapping[])[0]?.aliases.map((a) => a.aliasSku)).toEqual(['A33891']);
  });

  it('removes an alias left out of a later save', async () => {
    await put([{ supplierId: brakesId, supplierSku: '33891', aliases: ['A 33891', 'A33891'] }]);
    const res = await put([{ supplierId: brakesId, supplierSku: '33891', aliases: ['A33891'] }]);
    expect((res.json().data as Mapping[])[0]?.aliases.map((a) => a.aliasSku)).toEqual(['A33891']);
  });

  it('leaves aliases alone when the key is omitted', async () => {
    await put([{ supplierId: brakesId, supplierSku: '33891', aliases: ['A33891'] }]);
    const res = await put([{ supplierId: brakesId, supplierSku: '33891' }]);
    expect((res.json().data as Mapping[])[0]?.aliases.map((a) => a.aliasSku)).toEqual(['A33891']);
  });

  it('clears them when an empty list is sent', async () => {
    await put([{ supplierId: brakesId, supplierSku: '33891', aliases: ['A33891'] }]);
    const res = await put([{ supplierId: brakesId, supplierSku: '33891', aliases: [] }]);
    expect((res.json().data as Mapping[])[0]?.aliases).toEqual([]);
  });
});

describe('a code must point at one thing', () => {
  it('refuses an alias that is another line\'s main code', async () => {
    await put([
      { supplierId: brakesId, supplierSku: '33891' },
      { supplierId: brakesId, supplierSku: '114953' },
    ]);
    const res = await put([
      { supplierId: brakesId, supplierSku: '33891', aliases: ['114953'] },
      { supplierId: brakesId, supplierSku: '114953' },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/114953/);
    expect(res.json().error).toMatch(/main code/i);
  });

  it('refuses the same alias on two lines in one request', async () => {
    const res = await put([
      { supplierId: brakesId, supplierSku: '33891', aliases: ['A33891'] },
      { supplierId: brakesId, supplierSku: '114953', aliases: ['A33891'] },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/more than once/i);
  });

  it('writes nothing when an alias is rejected', async () => {
    const res = await put([
      { supplierId: brakesId, supplierSku: '33891', aliases: ['A33891'] },
      { supplierId: brakesId, supplierSku: '114953', aliases: ['A33891'] },
    ]);
    expect(res.statusCode).toBe(400);
    const db = getDb();
    const lines = await db
      .select()
      .from(supplierProducts)
      .where(eq(supplierProducts.productId, productId));
    expect(lines).toHaveLength(0);
  });
});

// Why the table exists: the next invoice line has to find this mapping.
describe('resolving a code off an invoice', () => {
  beforeEach(async () => {
    await put([
      { supplierId: brakesId, supplierSku: '33891', supplierPackSize: 25, aliases: ['A 33891', 'A33891'] },
    ]);
  });

  it('finds the mapping by its canonical code', async () => {
    const hit = await resolveSupplierSku(brakesId, '33891');
    expect(hit?.matchedVia).toBe('CANONICAL');
    expect(hit?.supplierProduct.supplierSku).toBe('33891');
  });

  it.each(['A 33891', 'A33891'])('finds the same mapping by the alias "%s"', async (sku) => {
    const hit = await resolveSupplierSku(brakesId, sku);
    expect(hit?.matchedVia).toBe('ALIAS');
    expect(hit?.supplierProduct.supplierSku).toBe('33891');
  });

  it('ignores case and surrounding whitespace, as OCR output does not', async () => {
    const hit = await resolveSupplierSku(brakesId, '  a33891  ');
    expect(hit?.supplierProduct.supplierSku).toBe('33891');
  });

  it('returns nothing for a code it has never seen', async () => {
    expect(await resolveSupplierSku(brakesId, '99999')).toBeNull();
  });

  it('does not resolve a code belonging to a different supplier', async () => {
    const db = getDb();
    const [other] = await db
      .insert(suppliers)
      .values({ companyId: COMPANY, name: 'Alias Test Other', slug: `${PREFIX}-brakes-2` })
      .returning();
    expect(await resolveSupplierSku(other!.id, 'A33891')).toBeNull();
    await db.delete(suppliers).where(eq(suppliers.id, other!.id));
  });

  // A retired line must stop catching invoice matches.
  it('stops resolving once the mapping is removed', async () => {
    await put([]);
    expect(await resolveSupplierSku(brakesId, 'A33891')).toBeNull();
  });
});
