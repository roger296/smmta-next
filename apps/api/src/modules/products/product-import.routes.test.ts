/**
 * POST /api/v1/products/import against a real database.
 *
 * The behaviour worth protecting is the round trip: what the Export button
 * produces must go back in unchanged, and edits to it must land. Everything
 * else here is a way the operator can get it wrong.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, like, sql } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { itemCategories, products } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

let app: FastifyInstance;
let token: string;

const PREFIX = 'IMPORTTEST-';
const CAT = 'ImportTest Dry Stock';
const COMPANY = getSingletonCompanyId();

const HEAD =
  'Name,Stock code,Stock UoM,Purchase UoM,Pack description,Expected next cost,Item category,Stock check instruction';

async function cleanup() {
  const db = getDb();
  await db.delete(products).where(like(products.stockCode, `${PREFIX}%`));
  await db
    .delete(itemCategories)
    .where(and(eq(itemCategories.companyId, COMPANY), like(itemCategories.name, 'ImportTest%')));
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  token = app.jwt.sign({
    userId: 'test-user',
    companyId: COMPANY,
    email: 'test@import.invalid',
    roles: ['admin'],
  });
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

function post(csv: string, query: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/products/import',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv' },
    query,
    payload: csv,
  });
}

async function findByCode(stockCode: string) {
  const db = getDb();
  const [row] = await db.select().from(products).where(eq(products.stockCode, stockCode)).limit(1);
  return row;
}

async function seedCategory(name = CAT) {
  const db = getDb();
  const [row] = await db
    .insert(itemCategories)
    .values({ companyId: COMPANY, name })
    .returning({ id: itemCategories.id });
  return row!.id;
}

describe('creating and updating', () => {
  it('creates a product that does not exist yet', async () => {
    const res = await post(
      `${HEAD}\r\nImport Flour,${PREFIX}001,g,sack,25 kg sack,0.0012,,\r\n`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ created: 1, updated: 0 });

    const row = await findByCode(`${PREFIX}001`);
    expect(row?.name).toBe('Import Flour');
    expect(row?.stockUom).toBe('g');
    expect(row?.packDescription).toBe('25 kg sack');
    expect(Number(row?.expectedNextCost)).toBeCloseTo(0.0012, 6);
  });

  it('updates the product with that stock code rather than making a second one', async () => {
    await post(`${HEAD}\r\nImport Flour,${PREFIX}001,g,sack,25 kg sack,0.0012,,\r\n`);
    const before = await findByCode(`${PREFIX}001`);

    const res = await post(
      `${HEAD}\r\nImport Flour Renamed,${PREFIX}001,g,sack,16 kg sack,0.0015,,\r\n`,
    );
    expect(res.json().data).toMatchObject({ created: 0, updated: 1 });

    const after = await findByCode(`${PREFIX}001`);
    expect(after?.id).toBe(before?.id); // same row, not a replacement
    expect(after?.name).toBe('Import Flour Renamed');
    expect(after?.packDescription).toBe('16 kg sack');

    const db = getDb();
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(eq(products.stockCode, `${PREFIX}001`));
    expect(count).toBe(1);
  });

  it('matches the stock code case-insensitively', async () => {
    await post(`${HEAD}\r\nImport Flour,${PREFIX}001,g,,,1,,\r\n`);
    const res = await post(
      `${HEAD}\r\nImport Flour Lower,${PREFIX.toLowerCase()}001,g,,,1,,\r\n`,
    );
    expect(res.json().data).toMatchObject({ created: 0, updated: 1 });
  });

  it('handles create and update in the same file', async () => {
    await post(`${HEAD}\r\nExisting,${PREFIX}001,g,,,1,,\r\n`);
    const res = await post(
      `${HEAD}\r\nExisting Updated,${PREFIX}001,g,,,2,,\r\nBrand New,${PREFIX}002,g,,,3,,\r\n`,
    );
    expect(res.json().data).toMatchObject({ created: 1, updated: 1 });
  });
});

describe('the new fields', () => {
  it('sets the stock check instruction', async () => {
    await post(
      `${HEAD}\r\nImport Flour,${PREFIX}001,g,,,1,,"Weigh, do not count"\r\n`,
    );
    expect((await findByCode(`${PREFIX}001`))?.stockCheckInstruction).toBe('Weigh, do not count');
  });

  it('resolves an item category by name, case-insensitively', async () => {
    const id = await seedCategory();
    await post(`${HEAD}\r\nImport Flour,${PREFIX}001,g,,,1,${CAT.toLowerCase()},\r\n`);
    expect((await findByCode(`${PREFIX}001`))?.itemCategoryId).toBe(id);
  });

  it('refuses an unknown category and names the ones that exist', async () => {
    await seedCategory();
    const res = await post(`${HEAD}\r\nImport Flour,${PREFIX}001,g,,,1,Dry Stok,\r\n`);
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.data.errors[0].message).toMatch(/"Dry Stok" does not exist/);
    expect(body.data.errors[0].message).toContain(CAT);
    expect(await findByCode(`${PREFIX}001`)).toBeUndefined();
  });

  it('creates the category when asked to explicitly', async () => {
    const res = await post(`${HEAD}\r\nImport Flour,${PREFIX}001,g,,,1,ImportTest New Cat,\r\n`, {
      createMissingCategories: 'true',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.createdCategories).toEqual(['ImportTest New Cat']);
    expect((await findByCode(`${PREFIX}001`))?.itemCategoryId).toBeTruthy();
  });

  it('clears the category when the cell is blanked', async () => {
    await seedCategory();
    await post(`${HEAD}\r\nImport Flour,${PREFIX}001,g,,,1,${CAT},\r\n`);
    expect((await findByCode(`${PREFIX}001`))?.itemCategoryId).toBeTruthy();

    await post(`${HEAD}\r\nImport Flour,${PREFIX}001,g,,,1,,\r\n`);
    expect((await findByCode(`${PREFIX}001`))?.itemCategoryId).toBeNull();
  });

  it('leaves the category alone when the column is absent', async () => {
    await seedCategory();
    await post(`${HEAD}\r\nImport Flour,${PREFIX}001,g,,,1,${CAT},\r\n`);
    const before = (await findByCode(`${PREFIX}001`))?.itemCategoryId;

    await post(`Name,Stock code\r\nImport Flour,${PREFIX}001\r\n`);
    expect((await findByCode(`${PREFIX}001`))?.itemCategoryId).toBe(before);
  });
});

describe('nothing is half-applied', () => {
  it('writes NO rows when any row is bad', async () => {
    const res = await post(
      `${HEAD}\r\nGood,${PREFIX}001,g,,,1,,\r\nBad,${PREFIX}002,g,,,not-a-number,,\r\n`,
    );
    expect(res.statusCode).toBe(422);
    expect(await findByCode(`${PREFIX}001`)).toBeUndefined();
    expect(await findByCode(`${PREFIX}002`)).toBeUndefined();
  });

  it('dry run reports what would happen and writes nothing', async () => {
    const res = await post(`${HEAD}\r\nImport Flour,${PREFIX}001,g,,,1,,\r\n`, {
      dryRun: 'true',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ dryRun: true, created: 1, updated: 0 });
    expect(await findByCode(`${PREFIX}001`)).toBeUndefined();
  });
});

describe('a database constraint becomes a readable row error', () => {
  // `products` has a unique index on (company_id, slug), and a spreadsheet can
  // easily carry a slug another product already owns. Without handling, the
  // whole request 500s and says nothing about which of hundreds of rows broke.
  it('names the row and the reason when a slug collides', async () => {
    const db = getDb();
    await db.insert(products).values({
      companyId: COMPANY,
      name: 'Slug Owner',
      stockCode: `${PREFIX}900`,
      slug: 'import-test-taken-slug',
    });

    const res = await post(
      'Name,Stock code,Slug\r\n' +
        `Other Product,${PREFIX}901,import-test-taken-slug\r\n`,
    );
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.data.errors).toHaveLength(1);
    expect(body.data.errors[0]).toMatchObject({ row: 2, stockCode: `${PREFIX}901` });
    expect(body.data.errors[0].message).toMatch(/Slug/);
    // Rolled back: the good row is not there either.
    expect(await findByCode(`${PREFIX}901`)).toBeUndefined();
    // And the pre-existing product is untouched.
    expect((await findByCode(`${PREFIX}900`))?.name).toBe('Slug Owner');
  });
});

describe('the export round-trips', () => {
  it('re-imports the export unchanged, updating every row in place', async () => {
    await post(
      `${HEAD}\r\nRound Trip A,${PREFIX}001,g,sack,25 kg sack,0.0012,,Check the date\r\n` +
        `Round Trip B,${PREFIX}002,each,box,box of 12,1.5,,\r\n`,
    );

    const exported = await app.inject({
      method: 'GET',
      url: '/api/v1/products/export.csv',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(exported.statusCode).toBe(200);

    const res = await post(exported.body);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    // Every product in the catalogue is matched, and none is created anew.
    expect(body.created).toBe(0);
    expect(body.updated).toBeGreaterThanOrEqual(2);

    const a = await findByCode(`${PREFIX}001`);
    expect(a?.name).toBe('Round Trip A');
    expect(a?.packDescription).toBe('25 kg sack');
    expect(a?.stockCheckInstruction).toBe('Check the date');
  });
});

describe('refusals', () => {
  it('401s without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products/import',
      headers: { 'content-type': 'text/csv' },
      payload: `${HEAD}\r\nX,${PREFIX}001,g,,,1,,\r\n`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('400s on an empty body, telling the operator to choose a file', async () => {
    const res = await post('');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/choose a file/i);
  });

  it('400s on a file with no Stock code column', async () => {
    const res = await post('Name,Stock UoM\r\nFlour,g\r\n');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Stock code/);
  });
});
