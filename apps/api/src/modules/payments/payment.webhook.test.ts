/**
 * Mollie webhook route content-type handling. Mollie POSTs the webhook as
 * application/x-www-form-urlencoded (`id=tr_...`), which Fastify has no built-in
 * parser for — without the scoped parser the route 415s before the handler ever
 * runs, so real Mollie callbacks would be dropped (status would rely solely on
 * polling). These tests pin the parser + the always-ACK-200 behaviour. The
 * service-level normalisation is covered by preorder.service.test.ts; here we
 * only assert the route accepts Mollie's wire format.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { closeDatabase } from '../../config/database.js';

describe('POST /api/v1/webhooks/mollie content types', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  it('accepts Mollie form-urlencoded body (200, not 415)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/mollie',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'id=tr_bogus123',
    });
    expect(res.statusCode).toBe(200);
  });

  it('still accepts application/json callers (200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/mollie',
      headers: { 'content-type': 'application/json' },
      payload: { id: 'tr_bogus123' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('ACKs 200 even on an unparseable body (never make Mollie retry us)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/mollie',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'nonsense=1',
    });
    expect(res.statusCode).toBe(200);
  });
});
