/**
 * Integration tests for product image uploads.
 *
 * These cover the bug that prompted the feature as much as the feature
 * itself: adding an image used to return 201 while products.hero_image_url
 * stayed untouched, so nothing a customer could see ever changed. The
 * assertions on hero/gallery are the ones that would have caught it.
 */
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { products } from '../../db/schema.js';
import {
  STOREFRONT_DEMO_COMPANY_ID,
  seedStorefront,
} from '../../../scripts/seed-storefront.js';

/**
 * A real 1x1 PNG. The route does not decode images, but a valid file keeps
 * the test honest about what is written to disk.
 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const IMPORTED_HERO = 'https://example.com/landau-pla-basic-black.png';

const FIXTURE_ROWS = [
  {
    stockCode: 'V3-PLA-BAS-BLACK',
    manufacturer: 'Landau',
    fullyQualifiedName: '1Kg Roll of FDM Printer Filament BLACK PLA Basic',
    oldGroupId: 55118,
    description: '1Kg Roll of FDM Printer Filament',
    netWeight: 1,
    shippingWeight: 1.3,
    dimensionH: 19,
    dimensionW: 19,
    dimensionD: 7,
    measurementUnit: 'cm',
    sellingPrice: 6.0,
    expectedNextCost: 3.42,
    rawColour: 'BLACKPLA Basic',
    stockQty: 5,
    imageUrl: IMPORTED_HERO,
  },
];

let app: FastifyInstance;
let token: string;
let productId: string;
let uploads: string;

/** Builds a multipart body by hand - no form-data dependency needed. */
function multipart(
  content: Buffer,
  { filename, contentType }: { filename: string; contentType: string },
) {
  const boundary = '----smmtaImageUploadTest';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length),
    },
  };
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  uploads = join(tmpdir(), `smmta-uploads-test-${Date.now()}`);
  process.env.UPLOADS_DIR = uploads;

  app = await buildApp();
  await app.ready();

  token = app.jwt.sign({
    userId: 'test-user',
    companyId: STOREFRONT_DEMO_COMPANY_ID,
    email: 'test@storefront-demo.invalid',
    roles: ['admin'],
  });

  await seedStorefront({ rows: FIXTURE_ROWS });

  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/products',
    headers: { authorization: `Bearer ${token}` },
    query: { search: 'Landau' },
  });
  const body = list.json() as { data: Array<{ id: string; stockCode: string }> };
  productId = body.data.find((p) => p.stockCode === 'V3-PLA-BAS-BLACK')!.id;
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
  await rm(uploads, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('POST /api/v1/products/:id/images/upload', () => {
  it('rejects an unauthenticated upload', async () => {
    const { payload, headers } = multipart(PNG_1x1, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/images/upload`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a file type that is not an allowed image', async () => {
    const { payload, headers } = multipart(Buffer.from('<svg/>'), {
      filename: 'x.svg',
      contentType: 'image/svg+xml',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/images/upload`,
      payload,
      headers: { ...headers, ...auth() },
    });
    expect(res.statusCode).toBe(415);
  });

  it('404s for a product that does not exist, without writing a file', async () => {
    const before = await readdir(uploads);
    const { payload, headers } = multipart(PNG_1x1, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products/00000000-0000-4000-8000-000000000000/images/upload',
      payload,
      headers: { ...headers, ...auth() },
    });
    expect(res.statusCode).toBe(404);
    expect(await readdir(uploads)).toEqual(before);
  });

  it('stores the file, serves it back, and updates the storefront columns', async () => {
    const { payload, headers } = multipart(PNG_1x1, {
      filename: 'photo.png',
      contentType: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${productId}/images/upload`,
      payload,
      headers: { ...headers, ...auth() },
    });
    expect(res.statusCode).toBe(201);

    const created = (res.json() as { data: { imageUrl: string } }).data;
    // The client's filename must not survive into the stored path.
    expect(created.imageUrl).not.toContain('photo');
    expect(created.imageUrl).toMatch(/\/uploads\/[0-9a-f-]{36}\.png$/);

    const filename = created.imageUrl.split('/').pop()!;
    expect(await readdir(uploads)).toContain(filename);

    const served = await app.inject({ method: 'GET', url: `/uploads/${filename}` });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(PNG_1x1)).toBe(true);

    // The point of the exercise: the denormalised columns the storefront
    // actually reads now include the upload.
    const [row] = await getDb()
      .select({
        hero: products.heroImageUrl,
        gallery: products.galleryImageUrls,
      })
      .from(products)
      .where(eq(products.id, productId));
    expect(row!.gallery).toContain(created.imageUrl);
    // The imported artwork is backfilled rather than discarded, and keeps
    // the hero slot because it was there first.
    expect(row!.gallery).toContain(IMPORTED_HERO);
    expect(row!.hero).toBe(IMPORTED_HERO);
  });

  it('re-syncs the columns when an image is removed', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${productId}/images`,
      headers: auth(),
    });
    const images = (list.json() as { data: Array<{ id: string; imageUrl: string }> }).data;
    const uploaded = images.find((i) => i.imageUrl.includes('/uploads/'))!;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${productId}/images/${uploaded.id}`,
      headers: auth(),
    });
    expect(del.statusCode).toBeLessThan(300);

    const [row] = await getDb()
      .select({ gallery: products.galleryImageUrls })
      .from(products)
      .where(eq(products.id, productId));
    expect(row!.gallery ?? []).not.toContain(uploaded.imageUrl);
  });
});
