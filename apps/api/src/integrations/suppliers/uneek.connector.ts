/**
 * Uneek Clothing connector.
 *
 * Implements `SupplierConnector` against https://api.uneekclothing.com/.
 * Endpoint paths and field mappings are in the constants block below so
 * they can be patched in one place. `UNEEK_API_NOTES.md` documents the
 * verified shapes (and where doc-driven assumptions still apply for the
 * order-side endpoints).
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
 * Timeouts: 30s default; order placement gets 60s because batched line
 * creation tends to be slow on the supplier's side.
 */
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
  /** Order placement — path not yet verified against live API. */
  ordersCreate: '/orders',
  /** Order status read — path not yet verified. */
  ordersStatus: '/orders',
  /** Order cancel — path not yet verified. */
  ordersCancel: '/orders',
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

interface UneekOrderResponse {
  orderRef?: string;
  reference?: string;
  id?: string;
  orderId?: string;
  status?: string;
  rejectionReason?: string;
  etaMinDays?: number;
  etaMaxDays?: number;
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

  async placeOrder(req: SupplierOrderRequest): Promise<SupplierOrderResponse> {
    const url = joinUrl(this.ctx.apiBaseUrl, ENDPOINTS.ordersCreate);
    const body = mapOrderRequestToUpstream(req);
    const upstream = await this.requestJson<UneekOrderResponse>('POST', url, body, {
      timeoutMs: ORDER_TIMEOUT_MS,
      idempotencyKey: req.idempotencyKey,
    });
    const upstreamStatus = (upstream.status ?? '').toUpperCase();
    const orderRef = upstream.orderRef ?? upstream.reference ?? upstream.id ?? upstream.orderId ?? '';
    if (upstreamStatus === 'REJECTED' || upstreamStatus === 'DECLINED') {
      throw new SupplierRejectedOrderError(
        upstream.rejectionReason ?? `Order rejected by supplier${orderRef ? ` (ref ${orderRef})` : ''}`,
        { raw: upstream },
      );
    }
    return {
      orderRef,
      status: 'ACCEPTED',
      etaDays:
        upstream.etaMinDays !== undefined && upstream.etaMaxDays !== undefined
          ? { min: upstream.etaMinDays, max: upstream.etaMaxDays }
          : undefined,
      raw: upstream,
    };
  }

  async getOrderStatus(orderRef: string): Promise<SupplierOrderStatus> {
    const url = joinUrl(this.ctx.apiBaseUrl, `${ENDPOINTS.ordersStatus}/${encodeURIComponent(orderRef)}`);
    const body = await this.requestJson<{
      status?: string;
      trackingCarrier?: string;
      trackingNumber?: string;
      shippedAt?: string;
      deliveredAt?: string;
    }>('GET', url, undefined);
    return {
      orderRef,
      status: body.status ?? 'UNKNOWN',
      trackingCarrier: body.trackingCarrier,
      trackingNumber: body.trackingNumber,
      shippedAt: body.shippedAt ? new Date(body.shippedAt) : undefined,
      deliveredAt: body.deliveredAt ? new Date(body.deliveredAt) : undefined,
      raw: body,
    };
  }

  async cancelOrder(orderRef: string): Promise<{ ok: boolean; reason?: string }> {
    const url = joinUrl(
      this.ctx.apiBaseUrl,
      `${ENDPOINTS.ordersCancel}/${encodeURIComponent(orderRef)}/cancel`,
    );
    try {
      await this.requestJson<unknown>('POST', url, {});
      return { ok: true };
    } catch (err) {
      if (err instanceof SupplierBadRequestError) {
        return { ok: false, reason: err.message };
      }
      throw err;
    }
  }

  // ----------------------------------------------------------
  // HTTP plumbing
  // ----------------------------------------------------------

  private async requestJson<T>(
    method: 'GET' | 'POST',
    url: string,
    body: unknown,
    opts: { timeoutMs?: number; idempotencyKey?: string } = {},
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

interface UneekOrderRequestBody {
  reference: string;
  shipping: {
    name: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    region?: string;
    postCode: string;
    country: string;
  };
  lines: Array<{ sku: string; quantity: number }>;
}

export function mapOrderRequestToUpstream(req: SupplierOrderRequest): UneekOrderRequestBody {
  return {
    reference: req.customerOrderRef,
    shipping: {
      name: req.shipping.name,
      addressLine1: req.shipping.line1,
      addressLine2: req.shipping.line2,
      city: req.shipping.city,
      region: req.shipping.region,
      postCode: req.shipping.postCode,
      country: req.shipping.country,
    },
    lines: req.lines.map((l) => ({ sku: l.supplierSku, quantity: l.qty })),
  };
}
