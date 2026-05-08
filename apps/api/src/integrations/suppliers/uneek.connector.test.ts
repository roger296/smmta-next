/**
 * Unit tests for `UneekConnector`.
 *
 * No live HTTP — every test stubs `globalThis.fetch` with canned
 * responses, then asserts the connector maps fields, classifies errors,
 * and forwards the idempotency key correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UneekConnector, mapOrderRequestToUpstream } from './uneek.connector.js';
import {
  SupplierAuthError,
  SupplierBadRequestError,
  SupplierRejectedOrderError,
  SupplierUnreachableError,
  SupplierUpstreamError,
} from './errors.js';
import type { SupplierConnectorContext } from './types.js';

const ctx: SupplierConnectorContext = {
  apiKey: 'test-key',
  apiBaseUrl: 'https://api.uneekclothing.example/',
  apiAuthScheme: 'bearer',
  timeoutMs: 5_000,
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(impl: (call: FetchCall) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return impl(call);
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

const ORIGINAL_FETCH = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('UneekConnector.getStockAndPrice', () => {
  it('returns one snapshot per requested SKU, mapping fields and synthesising missing ones', async () => {
    mockFetch(() =>
      jsonResponse({
        items: [
          { sku: 'SKU-A', stock: 12, costPrice: 4.95, updatedAt: '2026-05-08T07:00:00Z' },
          { sku: 'SKU-B', available: 0, cost: '7.25' },
        ],
      }),
    );
    const c = new UneekConnector(ctx);
    const r = await c.getStockAndPrice(['SKU-A', 'SKU-B', 'SKU-MISSING']);
    expect(r).toHaveLength(3);
    const a = r.find((s) => s.supplierSku === 'SKU-A')!;
    expect(a.stockQty).toBe(12);
    expect(a.costGbp).toBe(4.95);
    expect(a.lastUpdatedAt).toEqual(new Date('2026-05-08T07:00:00Z'));
    const b = r.find((s) => s.supplierSku === 'SKU-B')!;
    expect(b.stockQty).toBe(0);
    expect(b.costGbp).toBe(7.25); // string parsed to number
    const missing = r.find((s) => s.supplierSku === 'SKU-MISSING')!;
    expect(missing.stockQty).toBeNull();
    expect(missing.costGbp).toBeNull();
  });

  it('sends bearer auth and json body to the configured base URL', async () => {
    const calls = mockFetch(() => jsonResponse({ items: [] }));
    const c = new UneekConnector(ctx);
    await c.getStockAndPrice(['X']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.uneekclothing.example/v1/stock/lookup');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe(JSON.stringify({ skus: ['X'] }));
  });

  it('batches SKUs into 100 per request', async () => {
    const calls = mockFetch(() => jsonResponse({ items: [] }));
    const c = new UneekConnector(ctx);
    await c.getStockAndPrice(Array.from({ length: 250 }, (_, i) => `SKU-${i}`));
    expect(calls).toHaveLength(3); // 100 + 100 + 50
  });

  it('returns an empty array for an empty input', async () => {
    const calls = mockFetch(() => jsonResponse({ items: [] }));
    const c = new UneekConnector(ctx);
    const r = await c.getStockAndPrice([]);
    expect(r).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('UneekConnector — auth scheme variants', () => {
  it("uses bare api key when scheme is 'apikey'", async () => {
    const calls = mockFetch(() => jsonResponse({ items: [] }));
    const c = new UneekConnector({ ...ctx, apiAuthScheme: 'apikey' });
    await c.getStockAndPrice(['X']);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('test-key');
  });
});

describe('UneekConnector.placeOrder', () => {
  it('forwards the idempotency key and ACCEPTED upstream → ACCEPTED response', async () => {
    const calls = mockFetch(() =>
      jsonResponse({ orderRef: 'UNEEK-99', status: 'ACCEPTED', etaMinDays: 2, etaMaxDays: 5 }),
    );
    const c = new UneekConnector(ctx);
    const r = await c.placeOrder({
      idempotencyKey: 'idem-abc',
      customerOrderRef: 'CUST-1',
      shipping: {
        name: 'Pat Buyer',
        line1: '1 Test St',
        city: 'London',
        postCode: 'SW1A 1AA',
        country: 'GB',
      },
      lines: [{ supplierSku: 'SKU-A', qty: 2 }],
    });
    expect(r.status).toBe('ACCEPTED');
    expect(r.orderRef).toBe('UNEEK-99');
    expect(r.etaDays).toEqual({ min: 2, max: 5 });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['Idempotency-Key']).toBe('idem-abc');
  });

  it('throws SupplierRejectedOrderError when upstream returns REJECTED', async () => {
    mockFetch(() =>
      jsonResponse({ orderRef: 'UNEEK-99', status: 'REJECTED', rejectionReason: 'OOS' }),
    );
    const c = new UneekConnector(ctx);
    await expect(
      c.placeOrder({
        idempotencyKey: 'k',
        customerOrderRef: 'CUST',
        shipping: { name: 'X', line1: 'L', city: 'C', postCode: 'P', country: 'GB' },
        lines: [{ supplierSku: 'X', qty: 1 }],
      }),
    ).rejects.toThrow(SupplierRejectedOrderError);
  });
});

describe('UneekConnector — error classification', () => {
  it('401 → SupplierAuthError', async () => {
    mockFetch(() => jsonResponse({ error: 'unauthenticated' }, 401));
    const c = new UneekConnector(ctx);
    await expect(c.getStockAndPrice(['X'])).rejects.toThrow(SupplierAuthError);
  });

  it('400 → SupplierBadRequestError', async () => {
    mockFetch(() => jsonResponse({ error: 'bad sku' }, 400));
    const c = new UneekConnector(ctx);
    await expect(c.getStockAndPrice(['X'])).rejects.toThrow(SupplierBadRequestError);
  });

  it('500 → SupplierUpstreamError', async () => {
    mockFetch(() => jsonResponse({ error: 'oops' }, 500));
    const c = new UneekConnector(ctx);
    await expect(c.getStockAndPrice(['X'])).rejects.toThrow(SupplierUpstreamError);
  });

  it('network error → SupplierUnreachableError', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const c = new UneekConnector(ctx);
    await expect(c.getStockAndPrice(['X'])).rejects.toThrow(SupplierUnreachableError);
  });
});

describe('mapOrderRequestToUpstream', () => {
  it('maps shipping + line names into Uneek shape', () => {
    const out = mapOrderRequestToUpstream({
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
      lines: [
        { supplierSku: 'X', qty: 2 },
        { supplierSku: 'Y', qty: 5 },
      ],
    });
    expect(out).toEqual({
      reference: 'ORD-1',
      shipping: {
        name: 'Pat',
        addressLine1: 'A',
        addressLine2: 'B',
        city: 'C',
        region: 'R',
        postCode: 'PC',
        country: 'GB',
      },
      lines: [
        { sku: 'X', quantity: 2 },
        { sku: 'Y', quantity: 5 },
      ],
    });
  });
});

describe('UneekConnector.cancelOrder', () => {
  it('returns ok=true on 200', async () => {
    mockFetch(() => jsonResponse({}));
    const c = new UneekConnector(ctx);
    const r = await c.cancelOrder('UNEEK-1');
    expect(r).toEqual({ ok: true });
  });

  it('returns ok=false with the reason when the supplier 4xxs', async () => {
    mockFetch(() => jsonResponse({ error: 'already shipped' }, 409));
    const c = new UneekConnector(ctx);
    const r = await c.cancelOrder('UNEEK-1');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already shipped/i);
  });
});
