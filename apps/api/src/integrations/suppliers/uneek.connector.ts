/**
 * Uneek Clothing connector.
 *
 * Implements `SupplierConnector` against https://api.uneekclothing.com/.
 * The exact endpoint paths and field names are documented (and can be
 * patched without touching the rest of the system) in the constants
 * block at the top of this file. See `UNEEK_API_NOTES.md` for what the
 * upstream API actually exposes and how the field mappings were chosen.
 *
 * Auth: `Authorization: <scheme> <key>`, scheme defaults to `Bearer` but
 * the supplier row carries an `apiAuthScheme` column so an operator can
 * change it without code edits if Uneek's docs say otherwise.
 *
 * Timeouts: 10s connect, 30s overall per request. Order placement gets
 * 60s overall because batched line creation can be slow on their side.
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
// ------------------------------------------------------------
// These are the assumed shapes — patch here when the live API is
// confirmed. UNEEK_API_NOTES.md documents the assumptions in detail.
// ============================================================

const ENDPOINTS = {
  /** Batch stock-and-price lookup. Body: `{ skus: string[] }`.
   *  Response: `{ items: Array<{ sku, stock, costPrice, updatedAt? }> }`. */
  stockBatch: '/v1/stock/lookup',
  /** Single-order placement. Body: see `mapOrderRequestToUpstream` below. */
  ordersCreate: '/v1/orders',
  /** Single-order status read. Path: `${ordersStatus}/${orderRef}`. */
  ordersStatus: '/v1/orders',
  /** Single-order cancel. Path: `${ordersCancel}/${orderRef}/cancel`. */
  ordersCancel: '/v1/orders',
} as const;

const STOCK_BATCH_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const ORDER_TIMEOUT_MS = 60_000;

interface UneekStockItem {
  sku?: string;
  stock?: number | null;
  available?: number | null;
  qty?: number | null;
  costPrice?: number | string | null;
  cost?: number | string | null;
  updatedAt?: string | null;
}

interface UneekStockResponse {
  items?: UneekStockItem[];
  data?: UneekStockItem[];
  results?: UneekStockItem[];
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

// ============================================================
// Connector
// ============================================================

export class UneekConnector implements SupplierConnector {
  constructor(private readonly ctx: SupplierConnectorContext) {}

  async getStockAndPrice(supplierSkus: string[]): Promise<SupplierStockSnapshot[]> {
    if (supplierSkus.length === 0) return [];
    const out: SupplierStockSnapshot[] = [];
    for (let i = 0; i < supplierSkus.length; i += STOCK_BATCH_SIZE) {
      const chunk = supplierSkus.slice(i, i + STOCK_BATCH_SIZE);
      const url = joinUrl(this.ctx.apiBaseUrl, ENDPOINTS.stockBatch);
      const body = await this.requestJson<UneekStockResponse>('POST', url, {
        skus: chunk,
      });
      const items = body.items ?? body.data ?? body.results ?? [];
      const seen = new Set<string>();
      for (const it of items) {
        if (!it.sku) continue;
        seen.add(it.sku);
        out.push({
          supplierSku: it.sku,
          stockQty: pickFirstNumber(it.stock, it.available, it.qty),
          costGbp: pickFirstNumber(it.costPrice, it.cost),
          lastUpdatedAt: it.updatedAt ? new Date(it.updatedAt) : undefined,
        });
      }
      // SKUs we asked about but the supplier didn't return — emit
      // null-fields snapshots so the worker can mark them as
      // `last_poll_error = sku_not_found` rather than silently dropping.
      for (const sku of chunk) {
        if (!seen.has(sku)) {
          out.push({ supplierSku: sku, stockQty: null, costGbp: null });
        }
      }
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
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as undefined; surface the raw text via the error
      }
    }

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
