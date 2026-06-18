/**
 * Dormancy guard (P1, spec §A2).
 *
 * The Big Bakes fork keeps the inherited marketplace / storefront-search code
 * in the tree but dormant behind default-off feature flags. This test proves
 * the gate actually holds:
 *
 *   - with FEATURE_MARKETPLACE off (the default), POST /import/marketplace is
 *     never registered → 404;
 *   - a sibling route in the SAME integration plugin (POST /import/csv-orders)
 *     IS registered and therefore answers 401 (auth required), not 404 — so we
 *     know the plugin loaded and only the marketplace route was gated out;
 *   - getFeatures() reports both flags off by default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { getFeatures } from './env.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('dormant subsystems are off by default', () => {
  it('reports marketplace + conversational search off by default', () => {
    const features = getFeatures();
    expect(features.marketplace).toBe(false);
    expect(features.conversationalSearch).toBe(false);
  });

  it('does not register POST /import/marketplace (404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/import/marketplace',
      payload: { channel: 'SHOPIFY', accessToken: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('keeps the rest of the integration plugin live (csv import requires auth, not 404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/import/csv-orders',
      payload: { csvText: 'irrelevant' },
    });
    // Registered route, no JWT → 401 (definitively not a 404).
    expect(res.statusCode).toBe(401);
  });
});
