/**
 * Unit tests for `RalawiseConnector`.
 *
 * No live HTTP — every test stubs `globalThis.fetch` with canned
 * responses, then asserts:
 *   - the bearer token lifecycle works (cache, near-expiry refresh,
 *     401 retry, concurrent-call de-dupe)
 *   - credentials JSON parsing rejects malformed input
 *   - inventory responses are normalised correctly across the three
 *     code levels (variant, colour, group) and on the NotFound paths
 *   - order placement maps the neutral shape onto Ralawise's payload
 *     and classifies error/information messages correctly
 *   - getOrderStatus + cancelOrder don't pretend Ralawise supports
 *     features it doesn't document
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RalawiseConnector,
  flattenInventoryVariants,
  mapOrderRequestToRalawise,
  parseCredentials,
} from './ralawise.connector.js';
import {
  SupplierAuthError,
  SupplierBadRequestError,
  SupplierRejectedOrderError,
  SupplierUnreachableError,
  SupplierUpstreamError,
} from './errors.js';
import type { SupplierConnectorContext } from './types.js';

const ctx: SupplierConnectorContext = {
  apiKey: JSON.stringify({ user: 'roger@example.com', password: 'hunter2' }),
  apiBaseUrl: 'https://api.ralawise.example/v1',
  apiAuthScheme: 'bearer-with-login',
  timeoutMs: 5_000,
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetchSequence(...impls: Array<(call: FetchCall) => Promise<Response> | Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const impl = impls[Math.min(i, impls.length - 1)] ?? impls[impls.length - 1];
    i++;
    return impl!(call);
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Canned login response that returns a 20-minute token. */
function loginOk(token = 'test-jwt'): Response {
  return jsonResponse({
    access_token: token,
    token_type: 'bearer',
    expires_in: 1199,
  });
}

const ORIGINAL_FETCH = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ============================================================
// parseCredentials
// ============================================================

describe('parseCredentials', () => {
  it('parses valid JSON credentials', () => {
    const c = parseCredentials(JSON.stringify({ user: 'roger@example.com', password: 'hunter2' }));
    expect(c).toEqual({ user: 'roger@example.com', password: 'hunter2' });
  });
  it('trims whitespace on user', () => {
    const c = parseCredentials(JSON.stringify({ user: '  roger@example.com  ', password: 'x' }));
    expect(c.user).toBe('roger@example.com');
  });
  it('rejects empty apiKey', () => {
    expect(() => parseCredentials('')).toThrow(SupplierAuthError);
  });
  it('rejects non-JSON', () => {
    expect(() => parseCredentials('not json')).toThrow(SupplierAuthError);
  });
  it('rejects JSON that is not an object', () => {
    expect(() => parseCredentials('"just a string"')).toThrow(SupplierAuthError);
    expect(() => parseCredentials('null')).toThrow(SupplierAuthError);
    expect(() => parseCredentials('[]')).toThrow(SupplierAuthError);
  });
  it('rejects missing user', () => {
    expect(() => parseCredentials(JSON.stringify({ password: 'x' }))).toThrow(SupplierAuthError);
  });
  it('rejects missing password', () => {
    expect(() => parseCredentials(JSON.stringify({ user: 'a' }))).toThrow(SupplierAuthError);
  });
  it('rejects empty-string user', () => {
    expect(() => parseCredentials(JSON.stringify({ user: '', password: 'x' }))).toThrow(SupplierAuthError);
  });
});

// ============================================================
// flattenInventoryVariants
// ============================================================

describe('flattenInventoryVariants', () => {
  it('flattens a group-level response with multiple products', () => {
    const v = flattenInventoryVariants({
      productGroup: {
        id: 'GD001',
        products: [
          { productCode: 'GD001BLAC', variants: [{ sku: 'GD001BLACS' }, { sku: 'GD001BLACM' }] },
          { productCode: 'GD001REDD', variants: [{ sku: 'GD001REDDS' }] },
        ],
      },
    });
    expect(v.map((x) => x.sku)).toEqual(['GD001BLACS', 'GD001BLACM', 'GD001REDDS']);
  });
  it('handles a sku-level response (one product, one variant)', () => {
    const v = flattenInventoryVariants({
      productGroup: {
        id: 'GD001',
        products: [{ productCode: 'GD001BLAC', variants: [{ sku: 'GD001BLACS' }] }],
      },
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.sku).toBe('GD001BLACS');
  });
  it('returns [] when productGroup is missing', () => {
    expect(flattenInventoryVariants({})).toEqual([]);
  });
  it('returns [] when products is missing', () => {
    expect(flattenInventoryVariants({ productGroup: { id: 'X' } })).toEqual([]);
  });
});

// ============================================================
// Token lifecycle
// ============================================================

describe('RalawiseConnector — token lifecycle', () => {
  it('logs in on first inventory call and reuses the token', async () => {
    // Two SKUs from DIFFERENT product groups → two `/inventory/<group>`
    // calls (one per unique 5-char prefix). Same-group SKUs are
    // collapsed into a single request — see the dedicated test below.
    const calls = mockFetchSequence(
      () => loginOk('jwt-1'),
      () => jsonResponse({
        productGroup: { id: 'GD001', products: [{ productCode: 'GD001BLAC', variants: [{ sku: 'GD001BLACS', availableStock: { quantity: 7 } }] }] },
      }),
      () => jsonResponse({
        productGroup: { id: 'GD002', products: [{ productCode: 'GD002REDD', variants: [{ sku: 'GD002REDDS', availableStock: { quantity: 3 } }] }] },
      }),
    );
    const c = new RalawiseConnector(ctx);
    await c.getStockAndPrice(['GD001BLACS', 'GD002REDDS']);
    // 1 login + 2 inventory calls (one per group prefix)
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe('https://api.ralawise.example/v1/login');
    expect(calls[1]!.url).toBe('https://api.ralawise.example/v1/inventory/GD001');
    expect(calls[2]!.url).toBe('https://api.ralawise.example/v1/inventory/GD002');
    // Inventory calls send the cached bearer token
    const auth1 = (calls[1]!.init.headers as Record<string, string>).Authorization;
    const auth2 = (calls[2]!.init.headers as Record<string, string>).Authorization;
    expect(auth1).toBe('Bearer jwt-1');
    expect(auth2).toBe('Bearer jwt-1');
  });

  it('sends user+password JSON on login, NOT bearer header', async () => {
    const calls = mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ productGroup: { id: 'X', products: [] } }),
    );
    const c = new RalawiseConnector(ctx);
    await c.getStockAndPrice(['X']);
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(calls[0]!.init.body).toBe(JSON.stringify({ user: 'roger@example.com', password: 'hunter2' }));
  });

  it('retries once after a 401 mid-request (cached token expired early)', async () => {
    const calls = mockFetchSequence(
      () => loginOk('jwt-old'),
      () => jsonResponse({ error: 'unauthorized' }, 401),  // first inventory call: token stale
      () => loginOk('jwt-new'),                              // re-login
      () => jsonResponse({                                   // retry succeeds
        productGroup: { id: 'GD001', products: [{ productCode: 'GD001BLAC', variants: [{ sku: 'GD001BLACS', availableStock: { quantity: 1 } }] }] },
      }),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['GD001BLACS']);
    expect(r[0]).toEqual({ supplierSku: 'GD001BLACS', stockQty: 1, costGbp: null });
    expect(calls).toHaveLength(4);
    const retryAuth = (calls[3]!.init.headers as Record<string, string>).Authorization;
    expect(retryAuth).toBe('Bearer jwt-new');
  });

  it('throws SupplierAuthError when login itself returns 401/400', async () => {
    mockFetchSequence(() => jsonResponse({ error: 'bad creds' }, 401));
    const c = new RalawiseConnector(ctx);
    await expect(c.getStockAndPrice(['X'])).rejects.toThrow(SupplierAuthError);
  });

  it('de-dupes concurrent token requests (single login for multiple in-flight inventory calls)', async () => {
    // The same connector instance, two simultaneous getStockAndPrice
    // calls should share a single login fetch.
    let loginCalls = 0;
    let invCalls = 0;
    const fn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/login')) {
        loginCalls++;
        // Simulate slow login to make the race window real.
        await new Promise((r) => setTimeout(r, 10));
        return loginOk();
      }
      invCalls++;
      return jsonResponse({
        productGroup: { id: 'X', products: [{ productCode: 'XAB', variants: [{ sku: u.split('/').pop(), availableStock: { quantity: 1 } }] }] },
      });
    });
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    const c = new RalawiseConnector(ctx);
    await Promise.all([c.getStockAndPrice(['A']), c.getStockAndPrice(['B'])]);
    expect(loginCalls).toBe(1);
    expect(invCalls).toBe(2);
  });

  it('reflects token expiry on the cache for tests', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ productGroup: { id: 'X', products: [] } }),
    );
    const c = new RalawiseConnector(ctx);
    expect(c._getCachedTokenExpiry()).toBeNull();
    await c.getStockAndPrice(['X']);
    const expiry = c._getCachedTokenExpiry();
    expect(expiry).not.toBeNull();
    // Roughly 1199s ahead of now (allow generous slack for CI scheduling).
    expect(expiry! - Date.now()).toBeGreaterThan(1100_000);
    expect(expiry! - Date.now()).toBeLessThan(1300_000);
  });
});

// ============================================================
// getStockAndPrice — error + edge paths
// ============================================================

describe('RalawiseConnector.getStockAndPrice', () => {
  it('returns nulls for a 404 (SKU not in catalogue)', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ message: 'Not Found' }, 404),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['UNKNOWN']);
    expect(r).toEqual([{ supplierSku: 'UNKNOWN', stockQty: null, costGbp: null }]);
  });

  it('returns nulls when the response carries a NotFound information message at 200', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        Messages: [{ errorCode: 'NotFound', level: 'information', errorMessage: 'no data' }],
      }),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['UNKNOWN']);
    expect(r[0]).toEqual({ supplierSku: 'UNKNOWN', stockQty: null, costGbp: null });
  });

  it('costGbp is always null (inventory endpoint has no price)', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        productGroup: { id: 'GD001', products: [{ productCode: 'GD001BLAC', variants: [{ sku: 'GD001BLACS', availableStock: { quantity: 5 } }] }] },
      }),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['GD001BLACS']);
    expect(r[0]!.costGbp).toBeNull();
    expect(r[0]!.stockQty).toBe(5);
  });

  it('returns [] for an empty input (no HTTP calls)', async () => {
    const calls = mockFetchSequence(() => jsonResponse({}));
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice([]);
    expect(r).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('5xx → SupplierUpstreamError', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ error: 'down' }, 503),
    );
    const c = new RalawiseConnector(ctx);
    await expect(c.getStockAndPrice(['X'])).rejects.toThrow(SupplierUpstreamError);
  });

  it('429 → SupplierUpstreamError (rate-limit, retryable)', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ error: 'rate limited' }, 429),
    );
    const c = new RalawiseConnector(ctx);
    await expect(c.getStockAndPrice(['X'])).rejects.toThrow(SupplierUpstreamError);
  });

  it('network error → SupplierUnreachableError', async () => {
    let i = 0;
    globalThis.fetch = vi.fn(async () => {
      if (i++ === 0) return loginOk();
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const c = new RalawiseConnector(ctx);
    await expect(c.getStockAndPrice(['X'])).rejects.toThrow(SupplierUnreachableError);
  });

  it('picks the exact-match variant when the response carries multiple', async () => {
    // Variant-SKU query could in theory return the parent product +
    // all its size variants; the connector picks the exact match.
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        productGroup: {
          id: 'GD001',
          products: [{
            productCode: 'GD001BLAC',
            variants: [
              { sku: 'GD001BLACS', availableStock: { quantity: 100 } },
              { sku: 'GD001BLACM', availableStock: { quantity: 50 } },
            ],
          }],
        },
      }),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['GD001BLACM']);
    expect(r[0]!.stockQty).toBe(50);
  });

  it('collapses SKUs sharing a group prefix into ONE inventory call', async () => {
    // Three variants from the same product group (GD001) → the
    // connector should call /inventory/GD001 exactly once and resolve
    // all three SKUs from the single response. This is the whole point
    // of group-batching: ~22-variants/group on the real Ralawise
    // catalogue collapses what was a 96k-request poll into a 4.4k-
    // request poll, completing inside the 3-hour cadence rather than
    // running for days.
    const calls = mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        productGroup: {
          id: 'GD001',
          products: [
            {
              productCode: 'GD001BLAC',
              variants: [
                { sku: 'GD001BLACS', availableStock: { quantity: 11 } },
                { sku: 'GD001BLACM', availableStock: { quantity: 22 } },
                { sku: 'GD001BLACL', availableStock: { quantity: 33 } },
              ],
            },
          ],
        },
      }),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['GD001BLACS', 'GD001BLACM', 'GD001BLACL']);
    // 1 login + 1 inventory call total — NOT 1 login + 3 inventory calls.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://api.ralawise.example/v1/inventory/GD001');
    expect(r).toEqual([
      { supplierSku: 'GD001BLACS', stockQty: 11, costGbp: null },
      { supplierSku: 'GD001BLACM', stockQty: 22, costGbp: null },
      { supplierSku: 'GD001BLACL', stockQty: 33, costGbp: null },
    ]);
  });

  it('returns one snapshot per requested SKU even when a variant is missing from the group response', async () => {
    // We asked for three SKUs in the same group; Ralawise's response
    // only includes two (the third was discontinued and dropped from
    // the variant list). The missing one gets a null-fields snapshot
    // so the polling worker can flag it as sku_not_found.
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        productGroup: {
          id: 'GD001',
          products: [{
            productCode: 'GD001BLAC',
            variants: [
              { sku: 'GD001BLACS', availableStock: { quantity: 11 } },
              { sku: 'GD001BLACM', availableStock: { quantity: 22 } },
            ],
          }],
        },
      }),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['GD001BLACS', 'GD001BLACM', 'GD001BLACDISCONTINUED']);
    expect(r).toEqual([
      { supplierSku: 'GD001BLACS', stockQty: 11, costGbp: null },
      { supplierSku: 'GD001BLACM', stockQty: 22, costGbp: null },
      { supplierSku: 'GD001BLACDISCONTINUED', stockQty: null, costGbp: null },
    ]);
  });

  it('preserves the order of supplierSkus in the response', async () => {
    // The polling worker doesn't currently rely on response order
    // (it indexes via skuToMapping), but the documented contract is
    // "one snapshot per requested SKU" — being explicit about order
    // makes the path of least surprise.
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        productGroup: {
          id: 'GD001',
          products: [{
            productCode: 'GD001BLAC',
            variants: [
              { sku: 'GD001BLACS', availableStock: { quantity: 1 } },
              { sku: 'GD001BLACM', availableStock: { quantity: 2 } },
              { sku: 'GD001BLACL', availableStock: { quantity: 3 } },
            ],
          }],
        },
      }),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['GD001BLACL', 'GD001BLACS', 'GD001BLACM']);
    expect(r.map((s) => s.supplierSku)).toEqual(['GD001BLACL', 'GD001BLACS', 'GD001BLACM']);
    expect(r.map((s) => s.stockQty)).toEqual([3, 1, 2]);
  });

  it('returns null fields for every SKU in a group when the group endpoint 404s', async () => {
    // A whole group missing from Ralawise's catalogue: every requested
    // SKU in that group falls through to null fields, the worker logs
    // sku_not_found for each.
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ message: 'Not Found' }, 404),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['ZZ999AAA', 'ZZ999BBB']);
    expect(r).toEqual([
      { supplierSku: 'ZZ999AAA', stockQty: null, costGbp: null },
      { supplierSku: 'ZZ999BBB', stockQty: null, costGbp: null },
    ]);
  });

  it('handles a variant with no availableStock field (returns stockQty:null, not 0)', async () => {
    // Ralawise sometimes omits availableStock on variants pending
    // their next stock feed — that's not the same as "0 in stock".
    // The polling worker distinguishes null (unknown) from 0 (known
    // empty), so propagating null is meaningful.
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        productGroup: {
          id: 'GD001',
          products: [{ productCode: 'GD001BLAC', variants: [{ sku: 'GD001BLACS' }] }],
        },
      }),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.getStockAndPrice(['GD001BLACS']);
    expect(r[0]).toEqual({ supplierSku: 'GD001BLACS', stockQty: null, costGbp: null });
  });
});

// ============================================================
// placeOrder
// ============================================================

describe('RalawiseConnector.placeOrder', () => {
  const baseReq = {
    idempotencyKey: 'idem-1',
    customerOrderRef: 'ORD-1234',
    shipping: {
      name: 'Pat Buyer',
      line1: '1 Test St',
      city: 'London',
      postCode: 'SW1A 1AA',
      country: 'GB',
      region: 'England',
    },
    lines: [{ supplierSku: 'GD057INBLS', qty: 2 }],
  };

  it('places an order successfully and returns the upstream orderNumber', async () => {
    const calls = mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        order: { orderNumber: '20368068', orderReference: 'ORD-1234', createdDate: '2026-05-11T11:23:12' },
        messages: [],
      }, 201),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.placeOrder(baseReq);
    expect(r).toEqual({
      orderRef: '20368068',
      status: 'ACCEPTED',
      raw: expect.any(Object),
    });
    expect(calls[1]!.url).toBe('https://api.ralawise.example/v1/order');
    const sent = JSON.parse(calls[1]!.init.body as string);
    expect(sent.orderReference).toBe('ORD-1234');
    expect(sent.acceptTerms).toBe(true);
    expect(sent.delivery.deliveryOption.plainCover).toBe(true);
    expect(sent.delivery.deliveryOption.deliveryMethod).toBe('UKMAIN-UKNBD');
    expect(sent.lineItems[0]).toEqual({
      sku: 'GD057INBLS',
      quantity: 2,
      orderLineRef: 'idem-1',
      autoBackOrder: false,
    });
  });

  it('forwards the customerOrderRef as-is (including APITEST) — no auto-injection', async () => {
    const calls = mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ order: { orderNumber: '999' }, messages: [] }, 201),
    );
    const c = new RalawiseConnector(ctx);
    await c.placeOrder({ ...baseReq, customerOrderRef: 'APITEST' });
    const sent = JSON.parse(calls[1]!.init.body as string);
    expect(sent.orderReference).toBe('APITEST');
  });

  it('throws SupplierRejectedOrderError when the response carries error-level messages', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        messages: [{ errorCode: 'ContactNameRequired', errorMessage: 'Contact required', level: 'error' }],
      }, 400),
    );
    const c = new RalawiseConnector(ctx);
    // 400 short-circuits via the bad-request handler before the rejection check.
    await expect(c.placeOrder(baseReq)).rejects.toThrow(SupplierBadRequestError);
  });

  it('treats SkuNotFound information messages as ACCEPTED (Ralawise accepted the order)', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({
        order: { orderNumber: '20368069' },
        messages: [{ errorCode: 'SkuNotFound', errorMessage: 'sku missing', level: 'information' }],
      }, 200),
    );
    const c = new RalawiseConnector(ctx);
    const r = await c.placeOrder(baseReq);
    expect(r.status).toBe('ACCEPTED');
    expect(r.orderRef).toBe('20368069');
  });

  it('throws SupplierBadRequestError on a 400 with no order or messages', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ error: 'bad shape' }, 400),
    );
    const c = new RalawiseConnector(ctx);
    await expect(c.placeOrder(baseReq)).rejects.toThrow(SupplierBadRequestError);
  });

  it('throws if the response has no orderNumber on success', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ order: {}, messages: [] }, 201),
    );
    const c = new RalawiseConnector(ctx);
    await expect(c.placeOrder(baseReq)).rejects.toThrow(SupplierUpstreamError);
  });
});

// ============================================================
// getOrderStatus + cancelOrder — not supported
// ============================================================

describe('RalawiseConnector — rate-limit throttle', () => {
  it('inserts a delay between consecutive HTTP calls when minRequestIntervalMs is set', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ productGroup: { id: 'X', products: [{ productCode: 'XAB', variants: [{ sku: 'A' }] }] } }),
      () => jsonResponse({ productGroup: { id: 'X', products: [{ productCode: 'XAB', variants: [{ sku: 'B' }] }] } }),
    );
    // 50 ms is small enough to be CI-stable but big enough that
    // back-to-back calls measurably stretch out (50 ms × 2 SKU gaps).
    const c = new RalawiseConnector({ ...ctx, minRequestIntervalMs: 50 });
    const t0 = Date.now();
    await c.getStockAndPrice(['A', 'B']);
    const elapsed = Date.now() - t0;
    // Login + 2 inventory calls = 3 fetches → 2 throttle gaps × 50ms = ≥100ms.
    expect(elapsed).toBeGreaterThanOrEqual(80); // allow a little slack
  });

  it('does not throttle when minRequestIntervalMs is undefined / 0', async () => {
    mockFetchSequence(
      () => loginOk(),
      () => jsonResponse({ productGroup: { id: 'X', products: [{ productCode: 'XAB', variants: [{ sku: 'A' }] }] } }),
      () => jsonResponse({ productGroup: { id: 'X', products: [{ productCode: 'XAB', variants: [{ sku: 'B' }] }] } }),
    );
    const c = new RalawiseConnector(ctx); // no minRequestIntervalMs
    const t0 = Date.now();
    await c.getStockAndPrice(['A', 'B']);
    const elapsed = Date.now() - t0;
    // No throttle → should be fast (<50ms is comfortable; we assert <200 for CI slack).
    expect(elapsed).toBeLessThan(200);
  });
});

describe('RalawiseConnector.getOrderStatus', () => {
  it('returns UNKNOWN without making any HTTP call (endpoint not documented)', async () => {
    const calls = mockFetchSequence(() => jsonResponse({}));
    const c = new RalawiseConnector(ctx);
    const r = await c.getOrderStatus('20368068');
    expect(r.status).toBe('UNKNOWN');
    expect(r.orderRef).toBe('20368068');
    expect(calls).toHaveLength(0);
  });
});

describe('RalawiseConnector.cancelOrder', () => {
  it('returns ok=false with a helpful reason (endpoint not documented)', async () => {
    const calls = mockFetchSequence(() => jsonResponse({}));
    const c = new RalawiseConnector(ctx);
    const r = await c.cancelOrder('20368068');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ecommerce@ralawise/);
    expect(calls).toHaveLength(0);
  });
});

// ============================================================
// mapOrderRequestToRalawise
// ============================================================

describe('mapOrderRequestToRalawise', () => {
  it('maps shipping fields + sets plainCover=true and autoBackOrder=false', () => {
    const out = mapOrderRequestToRalawise({
      idempotencyKey: 'k',
      customerOrderRef: 'ORD-1',
      shipping: {
        name: 'Pat',
        line1: 'A',
        line2: 'B',
        city: 'C',
        region: 'R',
        postCode: 'PC',
        country: 'GB',
      },
      lines: [{ supplierSku: 'X', qty: 2 }],
    });
    expect(out.orderReference).toBe('ORD-1');
    expect(out.acceptTerms).toBe(true);
    expect(out.delivery.deliveryOption).toEqual({
      plainCover: true,
      deliveryMethod: 'UKMAIN-UKNBD',
    });
    expect(out.delivery.deliveryAddress).toEqual({
      deliveryAccountName: 'Pat',
      addressLine1: 'A',
      addressLine2: 'B',
      townCity: 'C',
      postcode: 'PC',
      countryCode: 'GB',
      countryName: 'R',
    });
    expect(out.lineItems[0]!.autoBackOrder).toBe(false);
  });

  it('truncates a long customerOrderRef to 20 chars (Ralawise schema limit)', () => {
    const out = mapOrderRequestToRalawise({
      idempotencyKey: 'k',
      customerOrderRef: 'ORD-WAY-TOO-LONG-FOR-RALAWISE-50-CHARS',
      shipping: { name: 'X', line1: 'L', city: 'C', postCode: 'P', country: 'GB' },
      lines: [{ supplierSku: 'X', qty: 1 }],
    });
    expect(out.orderReference.length).toBeLessThanOrEqual(20);
  });

  it('truncates idempotencyKey to 15 chars on orderLineRef (Ralawise schema limit)', () => {
    const out = mapOrderRequestToRalawise({
      idempotencyKey: 'idem-key-much-longer-than-fifteen',
      customerOrderRef: 'ORD-1',
      shipping: { name: 'X', line1: 'L', city: 'C', postCode: 'P', country: 'GB' },
      lines: [{ supplierSku: 'X', qty: 1 }],
    });
    expect(out.lineItems[0]!.orderLineRef!.length).toBeLessThanOrEqual(15);
  });

  it('throws on empty customerOrderRef', () => {
    expect(() =>
      mapOrderRequestToRalawise({
        idempotencyKey: 'k',
        customerOrderRef: '',
        shipping: { name: 'X', line1: 'L', city: 'C', postCode: 'P', country: 'GB' },
        lines: [{ supplierSku: 'X', qty: 1 }],
      }),
    ).toThrow(SupplierBadRequestError);
  });
});
