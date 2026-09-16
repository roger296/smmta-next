/**
 * Integration test for GET /api/v1/products/export.csv — the Export button on
 * the products page.
 *
 * The thing most worth holding here is that the export is NOT paginated. The
 * admin table pages at 25 and the API refuses a page over 250, so the easy
 * mistake is an export that quietly stops short; a CSV gives no hint that it
 * did. This seeds more products than a page holds and counts the rows back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inArray, like } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { products } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

let app: FastifyInstance;
let token: string;

/** Marks this test's rows so cleanup can't touch anybody else's. */
const PREFIX = 'EXPORTTEST-';
const SEEDED = 30; // > the admin page size of 25, and > nothing else in play

/** A name that opens as a live formula in Excel if nothing guards it. */
const FORMULA_NAME = '=HYPERLINK("http://evil.example","click")';
/** A name that breaks the column alignment if it is not quoted. */
const COMMA_NAME = 'Sugar, icing, 25 kg';

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();

  token = app.jwt.sign({
    userId: 'test-user',
    companyId: getSingletonCompanyId(),
    email: 'test@export.invalid',
    roles: ['admin'],
  });

  const db = getDb();
  await db.delete(products).where(like(products.stockCode, `${PREFIX}%`));
  await db.insert(products).values(
    Array.from({ length: SEEDED }, (_, i) => ({
      companyId: getSingletonCompanyId(),
      name:
        i === 0 ? FORMULA_NAME : i === 1 ? COMMA_NAME : `Export Test Product ${String(i).padStart(3, '0')}`,
      stockCode: `${PREFIX}${String(i).padStart(3, '0')}`,
      stockUom: 'g',
      purchaseUom: 'sack',
      packDescription: '25 kg sack',
      expectedNextCost: '0.001200',
      heroImageUrl: i === 2 ? 'https://cdn.example/hero.jpg' : null,
      galleryImageUrls: i === 2 ? ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] : null,
    })),
  );
});

afterAll(async () => {
  const db = getDb();
  await db.delete(products).where(like(products.stockCode, `${PREFIX}%`));
  await app.close();
  await closeDatabase();
});

async function fetchCsv() {
  return app.inject({
    method: 'GET',
    url: '/api/v1/products/export.csv',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /api/v1/products/export.csv', () => {
  it('serves a downloadable CSV with a dated filename', async () => {
    const res = await fetchCsv();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="products-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('starts with a UTF-8 BOM so Excel does not mangle accents', () => {
    return fetchCsv().then((res) => expect(res.body.charCodeAt(0)).toBe(0xfeff));
  });

  it('has a header row naming the fields', async () => {
    const res = await fetchCsv();
    const header = res.body.replace(/^﻿/, '').split('\r\n')[0]!;
    expect(header).toContain('Name');
    expect(header).toContain('Stock code');
    expect(header).toContain('Expected next cost');
    expect(header).toContain('Pack description');
    expect(header).toContain('Hero image URL');
  });

  // The point of the whole test file.
  it('returns EVERY product, not just the first page', async () => {
    const res = await fetchCsv();
    const seeded = Array.from({ length: SEEDED }, (_, i) => `${PREFIX}${String(i).padStart(3, '0')}`);
    const missing = seeded.filter((code) => !res.body.includes(code));
    expect(missing, `these seeded products are absent from the export: ${missing.join(', ')}`)
      .toEqual([]);
    expect(SEEDED).toBeGreaterThan(25);
  });

  it('writes one row per product — no duplicates from the image join', async () => {
    const res = await fetchCsv();
    const lines = res.body.replace(/^﻿/, '').split('\r\n');
    for (let i = 0; i < SEEDED; i++) {
      const code = `${PREFIX}${String(i).padStart(3, '0')}`;
      expect(lines.filter((l) => l.includes(code))).toHaveLength(1);
    }
  });

  it('exports image URLs rather than JSON or ids', async () => {
    const res = await fetchCsv();
    expect(res.body).toContain('https://cdn.example/hero.jpg');
    expect(res.body).toContain('https://cdn.example/a.jpg | https://cdn.example/b.jpg');
  });

  it('neutralises a product name that is a spreadsheet formula', async () => {
    const res = await fetchCsv();
    expect(res.body).toContain(`'=HYPERLINK`);
    expect(res.body).not.toContain(`,${FORMULA_NAME}`);
  });

  it('keeps a comma-laden name inside one quoted cell', async () => {
    const res = await fetchCsv();
    expect(res.body).toContain(`"${COMMA_NAME}"`);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/products/export.csv' });
    expect(res.statusCode).toBe(401);
  });

  it('is not mistaken for GET /products/:id', async () => {
    const res = await fetchCsv();
    expect(res.headers['content-type']).not.toContain('application/json');
  });
});
