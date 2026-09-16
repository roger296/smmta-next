/**
 * Unit tests for `UneekConnector`.
 *
 * No live HTTP — every test stubs `globalThis.fetch` with canned
 * responses, then asserts the connector maps fields, classifies errors,
 * handles the double-JSON-encoded body the live API returns, and
 * forwards idempotency keys correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UneekConnector,
  mapOrderRequestToUpstream,
  orderRefFrom,
  parseJsonBody,
} from './uneek.connector.js';
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
  apiAuthScheme: 'basic',
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

/** Default Content-Type: application/json. Body is whatever the test
 *  passes — usually a string for the stockLevel/all endpoint
 *  (double-encoded), an object for the order endpoints. */
function rawResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function jsonResponse(body: unknown, status = 200): Response {
  return rawResponse(JSON.stringify(body), status);
}

/** Build the same wire shape Uneek's live API actually returns from
 *  /stockLevel/all: a JSON-encoded string containing a JSON-encoded
 *  array. */
function uneekStockBody(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify(JSON.stringify(rows));
}

const ORIGINAL_FETCH = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('parseJsonBody', () => {
  it('parses a plain JSON array', () => {
    expect(parseJsonBody('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('parses a JSON-encoded-string-of-array (Uneek shape)', () => {
    expect(parseJsonBody(JSON.stringify('[1,2,3]'))).toEqual([1, 2, 3]);
  });
  it('returns the string as-is if the second parse fails', () => {
    expect(parseJsonBody(JSON.stringify('not json'))).toBe('not json');
  });
  it('returns undefined for empty input', () => {
    expect(parseJsonBody('')).toBeUndefined();
  });
  it('returns undefined for malformed json', () => {
    expect(parseJsonBody('not-json-at-all')).toBeUndefined();
  });
});

describe('UneekConnector.getStockAndPrice', () => {
  it('maps Uneek fields (ProductCode → supplierSku, LiveStock → stockQty); cost is always null', async () => {
    const calls = mockFetch(() =>
      rawResponse(
        uneekStockBody([
          { ProductCode: 'X03WH2XL', ProductName: 'UX3 - White - 2XL', LiveStock: 1000.0, StockIn7: 0, StockIn30: 0, StockDueDate: null },
          { ProductCode: 'X04WH4XL', ProductName: 'UX4 - White - 4XL', LiveStock: 161.0, StockIn7: 0, StockIn30: 0, StockDueDate: null },
        ]),
      ),
    );
    const c = new UneekConnector(ctx);
    const r = await c.getStockAndPrice(['X03WH2XL', 'X04WH4XL', 'NOT-IN-CATALOGUE']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.uneekclothing.example/stockLevel/all');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();

    expect(r).toHaveLength(3);
    const a = r.find((s) => s.supplierSku === 'X03WH2XL')!;
    expect(a.stockQty).toBe(1000);
    expect(a.costGbp).toBeNull();
    const b = r.find((s) => s.supplierSku === 'X04WH4XL')!;
    expect(b.stockQty).toBe(161);
    expect(b.costGbp).toBeNull();
    const missing = r.find((s) => s.supplierSku === 'NOT-IN-CATALOGUE')!;
    expect(missing.stockQty).toBeNull();
    expect(missing.costGbp).toBeNull();
  });

  it('sends the correct Basic auth + Accept headers', async () => {
    const calls = mockFetch(() => rawResponse(uneekStockBody([])));
    const c = new UneekConnector(ctx);
    await c.getStockAndPrice(['X']);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Basic test-key');
    expect(headers.Accept).toBe('application/json');
  });

  it('does NOT batch requests — one call regardless of how many SKUs were asked for', async () => {
    const calls = mockFetch(() => rawResponse(uneekStockBody([])));
    const c = new UneekConnector(ctx);
    await c.getStockAndPrice(Array.from({ length: 250 }, (_, i) => `SKU-${i}`));
    expect(calls).toHaveLength(1);
  });

  it('returns an empty array for an empty input (no HTTP call)', async () => {
    const calls = mockFetch(() => rawResponse(uneekStockBody([])));
    const c = new UneekConnector(ctx);
    const r = await c.getStockAndPrice([]);
    expect(r).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('also works when the response is a non-encoded JSON array (defensive)', async () => {
    // Some endpoints might return a normal JSON array (not double-encoded);
    // the parser falls through to a single-parse and the connector should
    // still cope.
    mockFetch(() =>
      rawResponse(
        JSON.stringify([
          { ProductCode: 'A', LiveStock: 5 },
        ]),
      ),
    );
    const c = new UneekConnector(ctx);
    const r = await c.getStockAndPrice(['A']);
    expect(r[0]!.stockQty).toBe(5);
  });
});

describe('UneekConnector.getProductCatalogue', () => {
  it('GETs /productdata/all with the customer number and returns the parsed array', async () => {
    const sample = [
      {
        ProductCode: 'UX8',
        ProductName: "The UX Children's Hooded Sweatshirt",
        ShortCode: 'X08HG7',
        Colour: 'Heather Grey',
        Hex: '#A6A6A6',
        Size: '7/8 YRS',
        MyPrice: 7.95,
        PriceSingle: 14.95,
        Image: 'https://example/heather-grey-7.jpg',
        FullDescription: 'A childrens hooded sweatshirt.',
        Category: "Children's Hooded Sweatshirts",
      },
      {
        ProductCode: 'UX10',
        ProductName: 'The UX Soft Shell Jacket',
        ShortCode: 'X10NV-M',
        Colour: 'Navy',
        Hex: 'NAVY',
        Size: 'M',
        MyPrice: '22.50',
        PriceSingle: '44.95',
        Category: 'Jackets',
      },
    ];
    const calls = mockFetch(() => rawResponse(uneekStockBody(sample)));
    const c = new UneekConnector(ctx);
    const rows = await c.getProductCatalogue('TBV02');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.uneekclothing.example/productdata/all?CustomerNo=TBV02');
    expect(calls[0]!.init.method).toBe('GET');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ProductCode).toBe('UX8');
    expect(rows[0]!.ShortCode).toBe('X08HG7');
    expect(rows[1]!.Category).toBe('Jackets');
  });

  it('returns [] when the upstream returns an empty array', async () => {
    mockFetch(() => rawResponse(uneekStockBody([])));
    const c = new UneekConnector(ctx);
    const rows = await c.getProductCatalogue('TBV02');
    expect(rows).toEqual([]);
  });

  it('returns [] when the upstream returns something that is not an array', async () => {
    mockFetch(() => jsonResponse({ unexpected: 'shape' }));
    const c = new UneekConnector(ctx);
    const rows = await c.getProductCatalogue('TBV02');
    expect(rows).toEqual([]);
  });

  it('propagates auth errors (401 → SupplierAuthError)', async () => {
    mockFetch(() => jsonResponse({ error: 'no' }, 401));
    const c = new UneekConnector(ctx);
    await expect(c.getProductCatalogue('TBV02')).rejects.toThrow(SupplierAuthError);
  });
});

describe('UneekConnector — auth scheme variants', () => {
  it("emits 'Basic <key>' when scheme is 'basic' (key already base64-encoded)", async () => {
    const calls = mockFetch(() => rawResponse(uneekStockBody([])));
    const c = new UneekConnector({ ...ctx, apiAuthScheme: 'basic', apiKey: 'cm9nZXI6cGFzcw==' });
    await c.getStockAndPrice(['X']);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Basic cm9nZXI6cGFzcw==');
  });

  it("base64-encodes 'user:pass' at request time when scheme is 'basic_credentials'", async () => {
    const calls = mockFetch(() => rawResponse(uneekStockBody([])));
    const c = new UneekConnector({ ...ctx, apiAuthScheme: 'basic_credentials', apiKey: 'roger:pass' });
    await c.getStockAndPrice(['X']);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from('roger:pass').toString('base64')}`);
  });

  it("emits 'Bearer <key>' when scheme is 'bearer'", async () => {
    const calls = mockFetch(() => rawResponse(uneekStockBody([])));
    const c = new UneekConnector({ ...ctx, apiAuthScheme: 'bearer' });
    await c.getStockAndPrice(['X']);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer test-key');
  });

  it("emits the bare key when scheme is 'apikey'", async () => {
    const calls = mockFetch(() => rawResponse(uneekStockBody([])));
    const c = new UneekConnector({ ...ctx, apiAuthScheme: 'apikey' });
    await c.getStockAndPrice(['X']);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('test-key');
  });
});

const ORDER = {
  idempotencyKey: 'idem-abc',
  customerOrderRef: 'STORE-ABC123',
  shipping: { name: 'Pat Buyer', line1: '1 Test St', city: 'London', postCode: 'SW1A 1AA', country: 'GB' },
  lines: [{ supplierSku: 'SKU-A', qty: 2 }],
  contactEmail: 'sales@example.invalid',
};

describe('UneekConnector.placeOrder', () => {
  it('POSTs an APIOrderRequest to /Order and reads the order number', async () => {
    const calls = mockFetch(() => jsonResponse({ OrderNumber: 'SO123456' }));
    const c = new UneekConnector(ctx);
    const r = await c.placeOrder(ORDER);
    expect(r.status).toBe('ACCEPTED');
    expect(r.orderRef).toBe('SO123456');
    expect(calls[0]!.url).toBe('https://api.uneekclothing.example/Order');
    expect(calls[0]!.init.method).toBe('POST');
    const sent = JSON.parse(String(calls[0]!.init.body)) as { orderReference: string; email: string };
    expect(sent.orderReference).toBe('STORE-ABC123');
    expect(sent.email).toBe('sales@example.invalid');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['Idempotency-Key']).toBe('idem-abc');
  });

  it('accepts a 200 with no JSON body and falls back to our reference', async () => {
    mockFetch(() => rawResponse('', 200));
    const r = await new UneekConnector(ctx).placeOrder(ORDER);
    expect(r).toMatchObject({ status: 'ACCEPTED', orderRef: 'STORE-ABC123' });
  });

  it('reads a bare order number string', async () => {
    mockFetch(() => rawResponse('SO-778', 200));
    const r = await new UneekConnector(ctx).placeOrder(ORDER);
    expect(r.orderRef).toBe('SO-778');
  });

  it('throws SupplierRejectedOrderError when a 200 reply says it failed', async () => {
    mockFetch(() => jsonResponse({ success: false, message: 'SKU-A is discontinued' }));
    await expect(new UneekConnector(ctx).placeOrder(ORDER)).rejects.toThrow(/discontinued/);
    mockFetch(() => jsonResponse({ status: 'REJECTED', rejectionReason: 'OOS' }));
    await expect(new UneekConnector(ctx).placeOrder(ORDER)).rejects.toThrow(SupplierRejectedOrderError);
  });

  it("sends the supplier record's account number on the query string", async () => {
    const calls = mockFetch(() => jsonResponse({ OrderNumber: 'SO1' }));
    await new UneekConnector({ ...ctx, accountNumber: ' TBV02 ' }).placeOrder(ORDER);
    expect(calls[0]!.url).toBe('https://api.uneekclothing.example/Order?CustomerNo=TBV02');
  });

  it("sends the supplier record's delivery method code", async () => {
    const calls = mockFetch(() => jsonResponse({ OrderNumber: 'SO1' }));
    await new UneekConnector({ ...ctx, deliveryMethodCode: ' DPD ' }).placeOrder(ORDER);
    const sent = JSON.parse(String(calls[0]!.init.body)) as {
      delivery: { deliveryOption: { deliveryMethod: string } };
    };
    expect(sent.delivery.deliveryOption.deliveryMethod).toBe('DPD');
  });

  it("sends the supplier record's account email in place of the contact email", async () => {
    const calls = mockFetch(() => jsonResponse({ OrderNumber: 'SO1' }));
    await new UneekConnector({ ...ctx, customerAccountEmail: ' roger@example.invalid ' }).placeOrder(ORDER);
    const sent = JSON.parse(String(calls[0]!.init.body)) as { email: string };
    expect(sent.email).toBe('roger@example.invalid');
  });

  it('429 → SupplierUpstreamError with status 429, safe for the placer to retry', async () => {
    mockFetch(() => jsonResponse({ error: 'slow down' }, 429));
    const err = await new UneekConnector(ctx).placeOrder(ORDER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierUpstreamError);
    expect((err as SupplierUpstreamError).status).toBe(429);
  });
});

describe('orderRefFrom', () => {
  it('finds common order-number fields, one level deep', () => {
    expect(orderRefFrom({ orderNumber: 42 })).toBe('42');
    expect(orderRefFrom({ data: { SalesOrderNumber: 'SO9' } })).toBe('SO9');
    expect(orderRefFrom({ message: 'Order created' })).toBeNull();
    expect(orderRefFrom('Order created successfully')).toBeNull();
  });
});

describe('UneekConnector.getOrderStatus', () => {
  it('searches /orders by reference', async () => {
    const calls = mockFetch(() => jsonResponse([{ Status: 'Despatched', TrackingNo: 'DPD123' }]));
    const r = await new UneekConnector(ctx).getOrderStatus('STORE-ABC123');
    expect(calls[0]!.url).toBe('https://api.uneekclothing.example/orders?reference=STORE-ABC123');
    expect(r).toMatchObject({ status: 'Despatched', trackingNumber: 'DPD123' });
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
  it('maps our order onto Uneek\'s APIOrderRequest', () => {
    const out = mapOrderRequestToUpstream(
      {
        idempotencyKey: 'k',
        customerOrderRef: 'ORD-1',
        shipping: {
          name: 'Pat',
          line1: 'A',
          line2: 'B',
          city: 'C',
          region: 'R',
          postCode: 'PC',
          country: 'UK',
        },
        lines: [
          { supplierSku: 'X', qty: 2 },
          { supplierSku: 'Y', qty: 5 },
        ],
        contactEmail: 'sales@example.invalid',
        contactPhone: '07700 900123',
      },
      { deliveryMethod: 'STD' },
    );
    expect(out).toEqual({
      email: 'sales@example.invalid',
      orderReference: 'ORD-1',
      orderNotes: '',
      specialInstructions: 'Recipient phone: 07700 900123',
      lineItems: [
        { sku: 'X', orderLineRef: '1', quantity: 2, autoBackOrder: false },
        { sku: 'Y', orderLineRef: '2', quantity: 5, autoBackOrder: false },
      ],
      delivery: {
        deliveryAddress: {
          deliveryAccountName: 'Pat',
          addressLine1: 'A',
          addressLine2: 'B',
          townCity: 'C',
          postcode: 'PC',
          countryCode: 'GB',
          countryName: 'United Kingdom',
        },
        deliveryOption: { plainCover: true, deliveryMethod: 'STD' },
      },
    });
  });
});

describe('UneekConnector.cancelOrder', () => {
  it('reports that Uneek cannot cancel through the API, without calling it', async () => {
    const calls = mockFetch(() => jsonResponse({}));
    const r = await new UneekConnector(ctx).cancelOrder('UNEEK-1');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot cancel/i);
    expect(calls).toHaveLength(0);
  });
});
