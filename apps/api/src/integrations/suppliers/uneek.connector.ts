/**
 * Uneek Clothing connector.
 *
 * Implements `SupplierConnector` against https://api.uneekclothing.com/.
 * Endpoint paths and field mappings are in the constants block below so
 * they can be patched in one place. `UNEEK_API_NOTES.md` documents the
 * verified shapes.
 *
 * Auth: HTTP Basic. The admin SPA's API-key field accepts either:
 *   - a pre-encoded `<base64(user:password)>` string, with `apiAuthScheme=basic`, OR
 *   - a raw `user:password` string, with `apiAuthScheme=basic_credentials` (the
 *     connector base64-encodes at request time).
 * `bearer` and `apikey` schemes are still supported for future suppliers.
 *
 * Stock endpoint quirks (verified 2026-05-11 against the live API):
 *   - `GET /stockLevel/all` returns the full catalogue stock state — no
 *     per-SKU filtering supported. The connector filters client-side.
 *   - The response body is a **double-JSON-encoded** string (the API
 *     emits `"[{...}]"` with `Content-Type: application/json`), so we
 *     parse, detect string, and parse again.
 *   - No cost-price field in the response. `costGbp` is returned as
 *     `null`; the polling worker / pricing helpers fall back to the
 *     operator-entered value on `supplier_products.cost_gbp`.
 *
 * Orders follow Uneek's Swagger 2.0 spec (/swagger/v1/swagger.json, read
 * 2026-09-14): `POST /Order` with an `APIOrderRequest` body, and
 * `GET /orders?reference=` to look one up. The spec declares no response
 * bodies and no cancel endpoint, so the order reference is read defensively
 * and cancelling is left to a person. Not yet exercised against the live API.
 *
 * Timeouts: 30s default; order placement gets 60s because batched line
 * creation tends to be slow on the supplier's side.
 */
import { getEnv } from '../../config/env.js';
import { countryCodeFor, countryNameFor } from './country.js';
import {
  SupplierAuthError,
  SupplierBadRequestError,
  SupplierRejectedOrderError,
  SupplierUnreachableError,
  SupplierUpstreamError,
} from './errors.js';
import type {
  SupplierConnector,
  SupplierConnectorContext,
  SupplierOrderRequest,
  SupplierOrderResponse,
  SupplierOrderStatus,
  SupplierStockSnapshot,
} from './types.js';

// ============================================================
// Endpoint + field-mapping constants
// ============================================================

const ENDPOINTS = {
  /** Verified 2026-05-11: GET, no params, returns the full catalogue
   *  as a (double-JSON-encoded) array of `{ ProductCode, ProductName,
   *  LiveStock, StockIn7, StockIn30, StockDueDate }` rows. */
  stockAll: '/stockLevel/all',
  /** Verified 2026-05-11: GET, no params, returns the full product
   *  catalogue (family + every variant) as a (double-JSON-encoded)
   *  array. See `UneekProductRow` for the shape, and
   *  `UNEEK_API_NOTES.md` for field-by-field documentation. Used by
   *  `scripts/import-uneek-products.ts` to seed our own
   *  `products` / `product_groups` / `supplier_products` tables. */
  productData: '/productdata/all',
  /** Order placement, from the Swagger spec: POST, body `APIOrderRequest`.
   *  Capital O, unlike every other path. */
  orderCreate: '/Order',
  /** Order search, from the Swagger spec: GET with `reference`, `date`,
   *  `invoice_no`, `shipment_no` or `tracking_no` query parameters. */
  ordersSearch: '/orders',
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const ORDER_TIMEOUT_MS = 60_000;

/** Shape of one row in the `GET /stockLevel/all` response. The API
 *  returns a string-encoded JSON array; we parse twice (see
 *  `parseJsonBody` below). */
interface UneekStockRow {
  ProductCode?: string;
  ProductName?: string;
  LiveStock?: number | string | null;
  StockIn7?: number | string | null;
  StockIn30?: number | string | null;
  StockDueDate?: string | null;
}

/**
 * One row from `GET /productdata/all` — the full Uneek product
 * catalogue. Field names mirror Uneek's wire format (PascalCase); the
 * importer maps these into our snake_case columns.
 *
 * `ProductCode` is the **family** code (e.g. `UX8` for "The UX
 * Children's Hooded Sweatshirt"). `ShortCode` is the per-variant SKU
 * (e.g. `X08HG7` = UX8 in Heather Grey size 7/8 yrs); `ShortCode` is
 * what gets passed to `/stockLevel/all` for stock lookups.
 *
 * Optional fields: every field beyond `ShortCode` is best-effort — the
 * importer must tolerate missing / null / empty values without
 * crashing. `Hex` in particular is messy (sometimes literal colour
 * names like `WHITE` rather than `#FFFFFF`) — the importer normalises
 * via `normaliseHex()`.
 */
export interface UneekProductRow {
  /** Family code; multiple variants share this. e.g. `UX8`. */
  ProductCode?: string;
  /** Family name. e.g. `The UX Children's Hooded Sweatshirt`. */
  ProductName?: string;
  /** Per-variant SKU. Use this for stock lookups. e.g. `X08HG7`. */
  ShortCode?: string;
  /** Variant axis: colour display name. */
  Colour?: string;
  /** Variant axis: hex colour. May be a `#RRGGBB`, may be a literal
   *  colour name like `WHITE`, may be empty. */
  Hex?: string | null;
  /** Variant axis: size. May be a clothing size (`XS`, `S`, …,
   *  `5XL`) or an age band for kids (`7/8 YRS`). */
  Size?: string;
  /** Wholesale price in GBP — what we pay. */
  MyPrice?: number | string | null;
  /** Suggested retail in GBP — what to sell at. */
  PriceSingle?: number | string | null;
  /** Bulk-pricing tiers — not consumed by the importer today. */
  Price12?: number | string | null;
  Price36?: number | string | null;
  Price72?: number | string | null;
  /** Variant-specific full image URL. */
  Image?: string | null;
  /** Lower-resolution per-colour swatch image. */
  SMColourImage?: string | null;
  /** High-resolution photo of this colour. `Image` is a model photo shared
   *  by every colour of the product, so this is the better variant image. */
  ColourImage?: string | null;
  /** e.g. `Unisex`, `Mens`, `Ladies`. */
  Gender?: string | null;
  /** Marketing copy — multi-paragraph. */
  FullDescription?: string | null;
  Specifications?: string | null;
  /** Short headline / strapline. */
  ShortDescription?: string | null;
  /** Category label, e.g. `Jackets`, `Children's Hooded Sweatshirts`.
   *  The importer's `--category` flag filters on this field. */
  Category?: string | null;
  /** Sub-category if present. */
  SubCategory?: string | null;
  /** Brand if present. */
  Brand?: string | null;
}

// ============================================================
// Helpers
// ============================================================

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function authHeader(ctx: SupplierConnectorContext): string {
  const scheme = (ctx.apiAuthScheme || 'bearer').toLowerCase();
  if (scheme === 'bearer') return `Bearer ${ctx.apiKey}`;
  if (scheme === 'apikey' || scheme === 'api-key') return ctx.apiKey;
  if (scheme === 'basic') return `Basic ${ctx.apiKey}`;
  if (scheme === 'basic_credentials' || scheme === 'basic-credentials') {
    // The apiKey is `user:password` plaintext — encode at request time
    // so the operator doesn't have to.
    return `Basic ${Buffer.from(ctx.apiKey, 'utf8').toString('base64')}`;
  }
  return `${ctx.apiAuthScheme} ${ctx.apiKey}`;
}

function pickFirstNumber(...candidates: Array<number | string | null | undefined>): number | null {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string') {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Uneek returns `Content-Type: application/json` but the body is a
 * JSON-encoded string containing a JSON-encoded array (i.e.
 * `"[{...}]"`). One `JSON.parse` gives back a string; we have to
 * detect that and parse again. This helper does up to two passes
 * and returns whatever the inner value is.
 */
export function parseJsonBody(text: string): unknown {
  if (!text) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

const ORDER_REF_KEYS = [
  'orderNumber', 'OrderNumber', 'salesOrderNumber', 'SalesOrderNumber', 'soNumber', 'SONumber',
  'orderRef', 'OrderRef', 'orderId', 'OrderId', 'id', 'Id',
];

/**
 * Uneek's order number from a POST /Order reply. The spec gives no response
 * shape, so look for the usual field names, one level of nesting deep, or a
 * bare reference string. Null when none is found.
 */
export function orderRefFrom(body: unknown, depth = 0): string | null {
  if (typeof body === 'number' && Number.isFinite(body)) return String(body);
  if (typeof body === 'string') {
    const t = body.trim();
    return /^[\w-]{1,50}$/.test(t) ? t : null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  for (const key of ORDER_REF_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  if (depth === 0) {
    for (const key of ['order', 'Order', 'data', 'Data', 'result', 'Result']) {
      const nested = rec[key];
      if (nested && typeof nested === 'object') {
        const ref = orderRefFrom(nested, 1);
        if (ref) return ref;
      }
    }
  }
  return null;
}

/** A refusal reason when a 2xx reply still says the order was not taken. */
export function rejectionFrom(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  const success = rec.success ?? rec.Success ?? rec.isSuccess ?? rec.IsSuccess;
  const status = String(rec.status ?? rec.Status ?? '').toUpperCase();
  if (success !== false && !['REJECTED', 'DECLINED', 'ERROR', 'FAILED', 'FAILURE'].includes(status)) {
    return null;
  }
  const reason =
    rec.rejectionReason ?? rec.message ?? rec.Message ?? rec.error ?? rec.Error ?? rec.errors ?? rec.Errors;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  return reason !== undefined
    ? `Uneek did not accept the order: ${JSON.stringify(reason).slice(0, 300)}`
    : 'Uneek did not accept the order';
}

function firstString(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

// ============================================================
// Connector
// ============================================================

export class UneekConnector implements SupplierConnector {
  constructor(private readonly ctx: SupplierConnectorContext) {}

  async getStockAndPrice(supplierSkus: string[]): Promise<SupplierStockSnapshot[]> {
    if (supplierSkus.length === 0) return [];

    // Uneek doesn't support per-SKU filtering on this endpoint — we
    // pull the whole catalogue and filter client-side. The response
    // is small enough (few thousand rows of compact JSON) that this
    // is reasonable at a 3-hour polling cadence.
    const url = joinUrl(this.ctx.apiBaseUrl, ENDPOINTS.stockAll);
    const body = await this.requestJson<unknown>('GET', url, undefined);

    const rows: UneekStockRow[] = Array.isArray(body) ? (body as UneekStockRow[]) : [];

    // Build a map by ProductCode so we can look up each requested SKU.
    const byCode = new Map<string, UneekStockRow>();
    for (const r of rows) {
      if (r.ProductCode) byCode.set(r.ProductCode, r);
    }

    const out: SupplierStockSnapshot[] = [];
    for (const sku of supplierSkus) {
      const r = byCode.get(sku);
      if (!r) {
        // SKU not present in Uneek's catalogue. The worker will mark
        // this as `last_poll_error = sku_not_found`.
        out.push({ supplierSku: sku, stockQty: null, costGbp: null });
        continue;
      }
      out.push({
        supplierSku: sku,
        stockQty: pickFirstNumber(r.LiveStock),
        // No cost in the stock-level endpoint; the supplier_products
        // row's operator-entered `cost_gbp` is the source of truth
        // for pricing. Returning null here means the polling worker
        // leaves `last_known_price` alone.
        costGbp: null,
      });
    }
    return out;
  }

  /**
   * Fetch the full Uneek product catalogue.
   *
   * Not on the neutral `SupplierConnector` interface — only the Uneek
   * connector exposes this today, and the importer script reaches for
   * `UneekConnector` directly. If other suppliers grow catalogue
   * endpoints we'll lift this to a shared interface; for now it stays
   * Uneek-specific so the contract isn't speculative.
   *
   * Same auth / double-JSON quirks as `getStockAndPrice` — see
   * `parseJsonBody`.
   */
  async getProductCatalogue(customerNo: string): Promise<UneekProductRow[]> {
    // Verified 2026-09-15: without CustomerNo Uneek answers 500; with the
    // account's number it returns a plain JSON array (~7,000 rows, ~9 MB).
    const url = `${joinUrl(this.ctx.apiBaseUrl, ENDPOINTS.productData)}?CustomerNo=${encodeURIComponent(customerNo)}`;
    const body = await this.requestJson<unknown>('GET', url, undefined);
    return Array.isArray(body) ? (body as UneekProductRow[]) : [];
  }

  async placeOrder(req: SupplierOrderRequest): Promise<SupplierOrderResponse> {
    const url = joinUrl(this.ctx.apiBaseUrl, ENDPOINTS.orderCreate);
    const body = mapOrderRequestToUpstream(req, { deliveryMethod: getEnv().UNEEK_DELIVERY_METHOD });
    const upstream = await this.requestJson<unknown>('POST', url, body, {
      timeoutMs: ORDER_TIMEOUT_MS,
      idempotencyKey: req.idempotencyKey,
      allowNonJson: true,
    });
    const rejection = rejectionFrom(upstream);
    if (rejection) {
      throw new SupplierRejectedOrderError(rejection, { raw: upstream });
    }
    return {
      // With no order number in the reply, our own reference still finds
      // the order through GET /orders?reference=.
      orderRef: orderRefFrom(upstream) ?? body.orderReference,
      status: 'ACCEPTED',
      raw: upstream,
    };
  }

  /** Looks the order up by the reference we sent. Field names are guesses
   *  until a live reply has been seen; unknown fields fall back to UNKNOWN. */
  async getOrderStatus(orderRef: string): Promise<SupplierOrderStatus> {
    const url = `${joinUrl(this.ctx.apiBaseUrl, ENDPOINTS.ordersSearch)}?reference=${encodeURIComponent(orderRef)}`;
    const body = await this.requestJson<unknown>('GET', url, undefined, { allowNonJson: true });
    const rows = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
    const row = (rows[0] ?? {}) as Record<string, unknown>;
    return {
      orderRef,
      status: firstString(row, 'status', 'Status', 'orderStatus', 'OrderStatus') ?? 'UNKNOWN',
      trackingCarrier: firstString(row, 'carrier', 'Carrier', 'courier', 'Courier'),
      trackingNumber: firstString(row, 'trackingNo', 'TrackingNo', 'trackingNumber', 'TrackingNumber'),
      raw: body,
    };
  }

  async cancelOrder(orderRef: string): Promise<{ ok: boolean; reason?: string }> {
    // Uneek's API has no cancel endpoint.
    return {
      ok: false,
      reason: `Uneek's API cannot cancel orders; ask Uneek to cancel order ${orderRef}.`,
    };
  }

  // ----------------------------------------------------------
  // HTTP plumbing
  // ----------------------------------------------------------

  private async requestJson<T>(
    method: 'GET' | 'POST',
    url: string,
    body: unknown,
    opts: { timeoutMs?: number; idempotencyKey?: string; allowNonJson?: boolean } = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: authHeader(this.ctx),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new SupplierUnreachableError(
        err instanceof Error ? err.message : 'unreachable',
        { raw: err },
      );
    } finally {
      clearTimeout(t);
    }

    const text = await res.text().catch(() => '');
    const parsed = parseJsonBody(text);

    if (res.status === 401 || res.status === 403) {
      throw new SupplierAuthError(`Uneek auth failed (${res.status})`, {
        status: res.status,
        raw: parsed ?? text,
      });
    }
    if (res.status === 429) {
      throw new SupplierUpstreamError('Uneek rate limit exceeded (429)', {
        status: 429,
        raw: parsed ?? text,
      });
    }
    if (res.status >= 400 && res.status < 500) {
      throw new SupplierBadRequestError(
        `Uneek bad request (${res.status}): ${text.slice(0, 200)}`,
        { status: res.status, raw: parsed ?? text },
      );
    }
    if (res.status >= 500) {
      throw new SupplierUpstreamError(`Uneek upstream ${res.status}`, {
        status: res.status,
        raw: parsed ?? text,
      });
    }
    if (parsed === undefined) {
      // The order endpoints declare no response body, so a 2xx with plain
      // text (or nothing) still means success there.
      if (opts.allowNonJson) return text as T;
      throw new SupplierUpstreamError('Uneek returned a non-JSON body', {
        status: res.status,
        raw: text,
      });
    }
    return parsed as T;
  }
}

// ============================================================
// Field mapping helpers (request side)
// ============================================================

/** Uneek's `APIOrderRequest`, from the Swagger spec. No field is marked required. */
export interface UneekOrderRequestBody {
  email: string;
  orderReference: string;
  orderNotes: string;
  specialInstructions: string;
  lineItems: Array<{
    sku: string;
    orderLineRef: string;
    quantity: number;
    autoBackOrder: boolean;
  }>;
  delivery: {
    deliveryAddress: {
      deliveryAccountName: string;
      addressLine1: string;
      addressLine2: string;
      townCity: string;
      postcode: string;
      countryCode: string;
      countryName: string;
    };
    deliveryOption: {
      plainCover: boolean;
      deliveryMethod: string;
    };
  };
}

/**
 * Map our neutral order onto Uneek's `APIOrderRequest`.
 *
 * - `plainCover: true`: the parcel carries no Uneek branding.
 * - `autoBackOrder: false`: a line Uneek cannot fill fails now rather than
 *   waiting silently at Uneek.
 * - `email` is our contact address, not the customer's.
 * - Uneek's address has no phone field, so the recipient's phone goes in
 *   `specialInstructions` for the courier.
 */
export function mapOrderRequestToUpstream(
  req: SupplierOrderRequest,
  opts: { deliveryMethod?: string } = {},
): UneekOrderRequestBody {
  return {
    email: req.contactEmail ?? '',
    orderReference: req.customerOrderRef,
    orderNotes: '',
    specialInstructions: req.contactPhone ? `Recipient phone: ${req.contactPhone}` : '',
    lineItems: req.lines.map((l, i) => ({
      sku: l.supplierSku,
      orderLineRef: String(i + 1),
      quantity: l.qty,
      autoBackOrder: false,
    })),
    delivery: {
      deliveryAddress: {
        deliveryAccountName: req.shipping.name,
        addressLine1: req.shipping.line1,
        addressLine2: req.shipping.line2 ?? '',
        townCity: req.shipping.city,
        postcode: req.shipping.postCode,
        countryCode: countryCodeFor(req.shipping.country),
        countryName: countryNameFor(req.shipping.country),
      },
      deliveryOption: {
        plainCover: true,
        deliveryMethod: opts.deliveryMethod ?? '',
      },
    },
  };
}
