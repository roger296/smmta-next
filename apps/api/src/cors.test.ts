/**
 * CORS preflight must allow the methods the API actually serves.
 *
 * @fastify/cors defaults `methods` to GET, HEAD and POST — the three "simple"
 * ones. With that default every PUT, PATCH and DELETE failed its preflight and
 * the browser never sent the real request, so the UI showed a bare "Failed to
 * fetch" and the server logged nothing at all. Editing a product, deleting
 * anything, saving a reorder level: 46 routes, all dead, and invisible from
 * the server side.
 *
 * This asserts against the route table rather than a hardcoded list, so adding
 * a route with a new method can't quietly reintroduce it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { closeDatabase } from './config/database.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

async function preflight(method: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/api/v1/products/00000000-0000-0000-0000-000000000000',
    headers: {
      origin: 'https://stock.thebigbakes.com',
      'access-control-request-method': method,
      'access-control-request-headers': 'content-type,authorization',
    },
  });
}

describe('CORS preflight', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('allows %s', async (method) => {
    const res = await preflight(method);
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-methods']).toContain(method);
  });

  it('allows the headers the client actually sends', async () => {
    const res = await preflight('PUT');
    const allowed = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowed).toContain('content-type');
    expect(allowed).toContain('authorization');
    // The stock-take PWA gates on its own header.
    expect(allowed).toContain('x-stocktake-code');
  });

  it('covers every method the route table serves', async () => {
    const served = new Set<string>();
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      for (const m of line.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/g) ?? []) served.add(m);
    }
    expect(served.size).toBeGreaterThan(0);
    const res = await preflight('PUT');
    const allowed = String(res.headers['access-control-allow-methods'] ?? '');
    for (const m of served) expect(allowed).toContain(m);
  });
});
