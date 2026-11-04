/**
 * Signed add-to-cart links: the API resolves a genuine token for the
 * storefront and refuses a tampered, expired or unpublished one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';
import { signedLink } from '../lib/tokens.js';
import { cleanupFixtures, makeApiKey, makeProduct } from '../testing.js';

let app: FastifyInstance;
let key: Awaited<ReturnType<typeof makeApiKey>>;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  key = await makeApiKey(['storefront:read']);
});
afterAll(async () => {
  await key.remove();
  await app.close();
  await cleanupFixtures();
});

const get = (t: string, auth = true) =>
  app.inject({ method: 'GET', url: `/api/v1/storefront/email-links/cart?t=${encodeURIComponent(t)}`, headers: auth ? { authorization: `Bearer ${key.raw}` } : {} });

describe('GET /storefront/email-links/cart', () => {
  it('names the exact variant and quantity for a genuine token', async () => {
    const p = await makeProduct('Landu PLA Basic Red');
    const res = await get(signedLink({ p: p.id, q: 2, c: 'contact' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { productId: p.id, quantity: 2 } });
  });

  it('refuses a tampered token', async () => {
    const p = await makeProduct('Landu PLA Basic Blue');
    const t = signedLink({ p: p.id, q: 1, c: 'contact' });
    const [, sig] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ p: p.id, q: 99, c: 'x', exp: 9_999_999_999 })).toString('base64url')}.${sig}`;
    expect((await get(forged)).statusCode).toBe(410);
  });

  it('refuses a token older than 30 days', async () => {
    const p = await makeProduct('Landu PLA Basic Green');
    const t = signedLink({ p: p.id, q: 1, c: 'contact' }, 30 * 86_400, Date.now() - 31 * 86_400_000);
    expect((await get(t)).statusCode).toBe(410);
  });

  it('refuses a product that is no longer published', async () => {
    const p = await makeProduct('Landu PLA Basic Grey', { isPublished: false });
    expect((await get(signedLink({ p: p.id, q: 1, c: 'contact' }))).statusCode).toBe(410);
  });

  it('needs the storefront key', async () => {
    expect((await get(signedLink({ p: 'x', q: 1, c: 'c' }), false)).statusCode).toBe(401);
  });
});
