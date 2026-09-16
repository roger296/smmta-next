import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, like } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { itemCategories, products } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

let app: FastifyInstance;
let token: string;
const COMPANY = getSingletonCompanyId();
const PREFIX = 'CatTest';

async function cleanup() {
  const db = getDb();
  await db.delete(products).where(like(products.stockCode, `${PREFIX}-%`));
  await db
    .delete(itemCategories)
    .where(and(eq(itemCategories.companyId, COMPANY), like(itemCategories.name, `${PREFIX}%`)));
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  token = app.jwt.sign({
    userId: 'test-user',
    companyId: COMPANY,
    email: 'test@cat.invalid',
    roles: ['admin'],
  });
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

const auth = () => ({ authorization: `Bearer ${token}` });

function create(name: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/item-categories',
    headers: auth(),
    payload: { name },
  });
}

describe('POST /api/v1/item-categories', () => {
  it('creates a category', async () => {
    const res = await create(`${PREFIX} Dry Stock`);
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ name: `${PREFIX} Dry Stock`, created: true });
  });

  it('trims the name, so " Bar " and "Bar" are one category', async () => {
    await create(`${PREFIX} Bar`);
    const res = await create(`  ${PREFIX} Bar  `);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.created).toBe(false);
  });

  // Pressing "Add" twice must not be an error the operator has to read, and
  // must never produce two categories that then split the catalogue.
  it('returns the existing category for a name that differs only in case', async () => {
    const first = await create(`${PREFIX} Packaging`);
    const second = await create(`${PREFIX} PACKAGING`);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.id).toBe(first.json().data.id);
    expect(second.json().data.created).toBe(false);
  });

  it('refuses an empty name', async () => {
    const res = await create('   ');
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/item-categories', () => {
  it('lists categories with how many products carry each', async () => {
    const made = await create(`${PREFIX} Counted`);
    const categoryId = made.json().data.id as string;
    const db = getDb();
    await db.insert(products).values({
      companyId: COMPANY,
      name: 'Cat Test Product',
      stockCode: `${PREFIX}-001`,
      itemCategoryId: categoryId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/item-categories',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const row = (res.json().data as Array<{ id: string; productCount: number }>).find(
      (c) => c.id === categoryId,
    );
    expect(row?.productCount).toBe(1);
  });

  it('401s without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/item-categories' });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /api/v1/item-categories/:id', () => {
  it('deletes an unused category', async () => {
    const made = await create(`${PREFIX} Unused`);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/item-categories/${made.json().data.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
  });

  // The FK is `on delete set null`, so a permitted delete would silently blank
  // the category on every product carrying it.
  it('refuses to delete one still in use, saying how many products', async () => {
    const made = await create(`${PREFIX} InUse`);
    const categoryId = made.json().data.id as string;
    const db = getDb();
    await db.insert(products).values({
      companyId: COMPANY,
      name: 'Cat Test Product',
      stockCode: `${PREFIX}-002`,
      itemCategoryId: categoryId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/item-categories/${categoryId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/still set on 1 product/);
  });

  it('a deleted name can be used again', async () => {
    const made = await create(`${PREFIX} Recycled`);
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/item-categories/${made.json().data.id}`,
      headers: auth(),
    });
    const again = await create(`${PREFIX} Recycled`);
    expect(again.statusCode).toBe(201);
  });
});
