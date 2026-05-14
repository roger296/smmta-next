/**
 * Ralawise connector.
 *
 * Implements `SupplierConnector` against https://api.ralawise.com/v1.
 * See `RALAWISE_API_NOTES.md` for the documented endpoint shapes,
 * chosen conventions (plainCover=true, autoBackOrder=false, etc),
 * and the credential-encoding scheme.
 *
 * # Auth
 *
 * Ralawise auth is a two-step bearer flow:
 *
 *   1. POST /v1/login with `{ user, password }` → `{ access_token,
 *      token_type: "bearer", expires_in: 1199 }` (20 min)
 *   2. Subsequent calls send `Authorization: Bearer <access_token>`
 *
 * Credentials are stored on `suppliers.apiKeyEnc` as the encrypted
 * JSON blob `{"user":"...","password":"..."}`. The registry passes
 * the *decrypted* JSON string as `ctx.apiKey`; this connector parses
 * + validates on construction.
 *
 * The 20-minute token TTL is handled by an internal cache:
 *   - first call: login + cache
 *   - within 60s of expiry: refresh proactively before issuing the
 *     real request (one-minute safety buffer)
 *   - on a 401 mid-request: drop the cache, re-login, retry once
 *
 * # Endpoints used
 *
 *   - GET /v1/inventory/<identifier>  (variant, colour, or group)
 *   - POST /v1/order                  (place an order)
 *
 * Ralawise does NOT document order-status or order-cancel endpoints.
 * `getOrderStatus` and `cancelOrder` therefore throw — see notes.
 *
 * # Rate limit
 *
 * 10 requests / 60 seconds per authenticated user (HTTP 429 if
 * exceeded). The polling worker's 3-hour cadence stays under this
 * comfortably even with hundreds of SKUs.
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
// Endpoint paths + tunables
// ============================================================

// NOTE: `apiBaseUrl` on the suppliers row is expected to include the
// `/v1` version segment (e.g. `https://api.ralawise.com/v1`). These
// paths are relative to that — don't add `/v1/` here or we double it.
const ENDPOINTS = {
  /** POST — `{user, password}` body, returns `{access_token, expires_in}`. */
  login: '/login',
  /** GET — `/inventory/{identifier}` where identifier is a variant
   *  SKU (10+ chars), a product code (group+colour, 9 chars) or a
   *  group code (5 chars). Same endpoint, three resolution levels. */
  inventory: '/inventory',
  /** POST — full order payload. Returns enriched order with
   *  `orderNumber`, line-item carton/pack/single splits, totals. */
  ordersCreate: '/order',
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const ORDER_TIMEOUT_MS = 60_000;
/** Re-login this many ms before the cached token actually expires.
 *  60 s is plenty of buffer for a long-running request to complete
 *  with a token that won't expire on the wire. */
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/** Default carrier method. UK Mainland, Standard Delivery (1-2 day
 *  dispatch). See Appendix in the Ralawise docs for the full list of
 *  delivery codes. Hard-coded for V1; surface as a configurable
 *  per-supplier field if we ever need EU / collection / pre-12 options. */
const DEFAULT_DELIVERY_METHOD = 'UKMAIN-UKNBD';

// ============================================================
// Ralawise wire shapes (subset we consume)
// ============================================================

/** Response from `POST /v1/login`. */
interface RalawiseLoginResponse {
  access_token?: string;
  token_type?: string;
  /** Seconds until token expires. Per docs: 1199 (~20 min). */
  expires_in?: number;
}

interface RalawisePackageUnit {
  carton?: number;
  pack?: number;
  single?: number;
}

interface RalawiseAvailableStock {
  quantity?: number;
}

interface RalawiseVariant {
  sku?: string;
  sizeCode?: string;
  sizeDescription?: string;
  packageUnit?: RalawisePackageUnit;
  availableStock?: RalawiseAvailableStock;
  onOrderStock?: { quantity?: number; expectedArrivalDate?: string };
  supplierStock?: { quantity?: number; leadTime?: string };
}

interface RalawiseProduct {
  productCode?: string;
  colourCode?: string;
  colourDescription?: string;
  variants?: RalawiseVariant[];
}

interface RalawiseInventoryResponse {
  productGroup?: {
    id?: string;
    name?: string;
    products?: RalawiseProduct[];
  };
  Messages?: RalawiseMessage[];
  messages?: RalawiseMessage[];
}

interface RalawiseMessage {
  errorCode?: string;
  errorMessage?: string;
  /** `'information'` (200-range) or `'error'` (non-200). */
  level?: string;
  parameterName?: string;
}

interface RalawiseOrderLineResponse {
  sku?: string;
  brand?: string;
  title?: string;
  productCode?: string;
  colourCode?: string;
  colourDescription?: string;
  size?: string;
  orderLineRef?: string;
  quantity?: number;
  allocatedQuantity?: number;
  quantityBreak?: string;
  currency?: string;
  unitPrice?: number;
  linePrice?: number;
  vat?: number;
}

interface RalawiseOrderResponse {
  order?: {
    orderNumber?: string | number;
    orderReference?: string;
    createdDate?: string;
    lineItems?: RalawiseOrderLineResponse[];
    totals?: {
      subTotal?: number;
      vat?: number;
      delivery?: number;
      orderTotal?: number;
      total?: number;
      orderQuantityTotal?: number;
      allocatedQuantityTotal?: number;
      orderQuantity?: number;
      allocatedQuantity?: number;
    };
  };
  messages?: RalawiseMessage[];
  Messages?: RalawiseMessage[];
}

// ============================================================
// Helpers
// ============================================================

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/** Parse + validate `{user, password}` from the JSON-encoded apiKey. */
export interface RalawiseCredentials {
  user: string;
  password: string;
}
export function parseCredentials(apiKey: string): RalawiseCredentials {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new SupplierAuthError('Ralawise apiKey is empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(apiKey);
  } catch {
    throw new SupplierAuthError(
      'Ralawise apiKey must be a JSON object with `user` and `password` — got non-JSON',
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SupplierAuthError('Ralawise apiKey must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const user = typeof obj.user === 'string' ? obj.user.trim() : '';
  const password = typeof obj.password === 'string' ? obj.password : '';
  if (!user || !password) {
    throw new SupplierAuthError(
      'Ralawise apiKey must have non-empty `user` and `password` fields',
    );
  }
  return { user, password };
}

/** Flatten an inventory response's nested product-group → product →
 *  variants tree into a flat list of variants. Each level can have
 *  multiple children (group-level query) or just one (sku-level). */
export function flattenInventoryVariants(body: RalawiseInventoryResponse): RalawiseVariant[] {
  const products = body?.productGroup?.products ?? [];
  const out: RalawiseVariant[] = [];
  for (const p of products) {
    for (const v of p.variants ?? []) out.push(v);
  }
  return out;
}

/** Find a "SKU not in catalogue" information message in either
 *  Messages array (the docs use both PascalCase and camelCase). */
function findNotFoundMessage(body: { Messages?: RalawiseMessage[]; messages?: RalawiseMessage[] }): RalawiseMessage | undefined {
  const all = [...(body.Messages ?? []), ...(body.messages ?? [])];
  return all.find((m) => m.errorCode === 'NotFound');
}

// ============================================================
// Connector
// ============================================================

interface CachedToken {
  token: string;
  /** Absolute epoch-ms when the token becomes unusable. We refresh
   *  TOKEN_REFRESH_BUFFER_MS before this. */
  expiresAt: number;
}

export class RalawiseConnector implements SupplierConnector {
  private readonly creds: RalawiseCredentials;
  private cachedToken: CachedToken | null = null;
  /** Inflight login promise — if multiple callers race for a token
   *  during refresh, they share the same network call rather than
   *  each issuing their own login. */
  private inflightLogin: Promise<string> | null = null;
  /** Epoch-ms of the earliest moment the next request may be sent.
   *  Updated after every `fetchRaw` call. Zero = no pending throttle. */
  private nextRequestAllowedAt = 0;

  constructor(private readonly ctx: SupplierConnectorContext) {
    this.creds = parseCredentials(ctx.apiKey);
  }

  /** Internal: wait until the throttle window has elapsed. No-op when
   *  `minRequestIntervalMs` isn't set on the context. Exposed for tests. */
  /** @internal */
  async _awaitThrottle(now = Date.now()): Promise<void> {
    const interval = this.ctx.minRequestIntervalMs ?? 0;
    if (interval <= 0) return;
    const waitMs = this.nextRequestAllowedAt - now;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // ----------------------------------------------------------
  // Token lifecycle
  // ----------------------------------------------------------

  /** Returns a valid bearer token, refreshing if expiring soon. */
  private async getValidToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.cachedToken.token;
    }
    return this.refreshToken();
  }

  /** Force a new login. De-dupes concurrent calls via `inflightLogin`. */
  private async refreshToken(): Promise<string> {
    if (this.inflightLogin) return this.inflightLogin;
    this.inflightLogin = (async () => {
      try {
        const url = joinUrl(this.ctx.apiBaseUrl, ENDPOINTS.login);
        const res = await this.fetchRaw('POST', url, this.creds, { auth: false });
        const text = await res.text().catch(() => '');
        const parsed = safeJsonParse<RalawiseLoginResponse>(text);
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          throw new SupplierAuthError(`Ralawise login rejected (${res.status})`, {
            status: res.status,
            raw: parsed ?? text,
          });
        }
        if (res.status >= 500) {
          throw new SupplierUpstreamError(`Ralawise login upstream ${res.status}`, {
            status: res.status,
            raw: parsed ?? text,
          });
        }
        if (!res.ok || !parsed?.access_token) {
          throw new SupplierUpstreamError('Ralawise login returned no access_token', {
            status: res.status,
            raw: parsed ?? text,
          });
        }
        const expiresIn = typeof parsed.expires_in === 'number' && parsed.expires_in > 0
          ? parsed.expires_in
          : 1199;
        this.cachedToken = {
          token: parsed.access_token,
          expiresAt: Date.now() + expiresIn * 1000,
        };
        return parsed.access_token;
      } finally {
        this.inflightLogin = null;
      }
    })();
    return this.inflightLogin;
  }

  /** Drops the cached token. Called when a 401 comes back from a
   *  resource endpoint — the token may have been revoked early or
   *  the cache is somehow corrupt. */
  private invalidateToken(): void {
    this.cachedToken = null;
  }

  // Exposed for tests only.
  /** @internal */
  _getCachedTokenExpiry(): number | null {
    return this.cachedToken?.expiresAt ?? null;
  }

  // ----------------------------------------------------------
  // SupplierConnector — inventory
  // ----------------------------------------------------------

  async getStockAndPrice(supplierSkus: string[]): Promise<SupplierStockSnapshot[]> {
    if (supplierSkus.length === 0) return [];

    // Group SKUs by their 5-char product-group prefix so each unique
    // group is fetched exactly once, regardless of how many of its
    // variants we have mapped. The `/inventory/<groupCode>` endpoint
    // returns every variant in the group in one response — for a
    // catalogue of ~96k SKUs across ~4.4k groups (~22 variants/group on
    // average) this turns a 96k-request poll into a 4.4k-request poll.
    //
    // At Ralawise's documented rate limit (10 req / 60s, ~6.6s/req with
    // our 10 % safety margin) that's the difference between a multi-day
    // poll and an overnight one — without group-batching the 3-hour
    // poll cadence can never complete a cycle, and the supplier_products
    // rows never have stock data refreshed.
    //
    // SKUs shorter than 5 chars (rare; defensive) fall back to using
    // the SKU itself as the group key — the Ralawise endpoint also
    // accepts colour-level (9-char) and group-level (5-char) codes at
    // the same path and resolves to whichever level matches.
    const groupOf = (sku: string): string => (sku.length >= 5 ? sku.slice(0, 5) : sku);
    const uniqueGroups = new Set<string>();
    for (const sku of supplierSkus) uniqueGroups.add(groupOf(sku));

    // Fetch each group once and build a flat SKU → variant lookup. A
    // group that 404s (or returns a NotFound information message) just
    // contributes no entries to the map; SKUs in that group end up with
    // null fields in the final snapshot list.
    const variantBySku = new Map<string, RalawiseVariant>();
    for (const groupKey of uniqueGroups) {
      const body = await this.fetchInventoryOrNull(groupKey);
      if (!body) continue;
      for (const v of flattenInventoryVariants(body)) {
        if (v.sku) variantBySku.set(v.sku, v);
      }
    }

    // Emit one snapshot per requested SKU. A missing entry means the
    // variant wasn't in the group response — either the whole group
    // 404'd, or the variant was discontinued and dropped from the
    // group's variant list. Either way, the polling worker treats the
    // null-fields snapshot as `sku_not_found` and the storefront stops
    // surfacing the variant as available.
    return supplierSkus.map((sku): SupplierStockSnapshot => {
      const v = variantBySku.get(sku);
      if (!v) return { supplierSku: sku, stockQty: null, costGbp: null };
      return {
        supplierSku: sku,
        stockQty: typeof v.availableStock?.quantity === 'number'
          ? v.availableStock.quantity
          : null,
        // The inventory endpoint does NOT return prices. Cost comes from
        // the operator-entered `supplier_products.cost_gbp` instead.
        costGbp: null,
      };
    });
  }

  /** Fetch the inventory for an identifier (variant SKU, colour code,
   *  or group code — Ralawise resolves to whichever level matches).
   *  Returns null on 404 or on a 200-with-NotFound-information-message;
   *  re-throws everything else. */
  private async fetchInventoryOrNull(identifier: string): Promise<RalawiseInventoryResponse | null> {
    const url = joinUrl(this.ctx.apiBaseUrl, `${ENDPOINTS.inventory}/${encodeURIComponent(identifier)}`);
    let body: RalawiseInventoryResponse;
    try {
      body = await this.requestJson<RalawiseInventoryResponse>('GET', url, undefined);
    } catch (err) {
      if (err instanceof SupplierBadRequestError && err.status === 404) return null;
      throw err;
    }
    if (findNotFoundMessage(body)) return null;
    return body;
  }

  // ----------------------------------------------------------
  // SupplierConnector — orders
  // ----------------------------------------------------------

  async placeOrder(req: SupplierOrderRequest): Promise<SupplierOrderResponse> {
    const url = joinUrl(this.ctx.apiBaseUrl, ENDPOINTS.ordersCreate);
    const body = mapOrderRequestToRalawise(req);
    let upstream: RalawiseOrderResponse;
    try {
      upstream = await this.requestJson<RalawiseOrderResponse>('POST', url, body, {
        timeoutMs: ORDER_TIMEOUT_MS,
      });
    } catch (err) {
      // 400 with a "validation" error code is a client-side mistake
      // (rejected, won't fix itself). The placer worker shouldn't retry.
      throw err;
    }
    const order = upstream.order;
    const allMessages = [...(upstream.messages ?? []), ...(upstream.Messages ?? [])];
    // Allocation-failure information messages are NOT a rejection —
    // Ralawise has accepted the order, just with adjusted quantity.
    // The placer worker stores the response payload and the operator
    // can reconcile if needed.
    const errorLevelMessages = allMessages.filter((m) => m.level === 'error');
    if (errorLevelMessages.length > 0) {
      throw new SupplierRejectedOrderError(
        errorLevelMessages.map((m) => m.errorMessage ?? m.errorCode ?? 'order rejected').join('; '),
        { raw: upstream },
      );
    }
    const orderRef = order?.orderNumber !== undefined ? String(order.orderNumber) : (order?.orderReference ?? '');
    if (!orderRef) {
      // Defensive: should never happen on a 200/201 with no error
      // messages, but if it does we'd rather fail loudly than silently
      // record an empty supplier order reference.
      throw new SupplierUpstreamError('Ralawise order accepted but returned no orderNumber', {
        raw: upstream,
      });
    }
    return {
      orderRef,
      status: 'ACCEPTED',
      // Ralawise doesn't document an ETA per order. Their dispatch SLA
      // is "1-2 day" per the default carriage method name; the
      // supplier row's dispatchSlaMinDays/dispatchSlaMaxDays carry the
      // customer-facing copy via the storefront.
      raw: upstream,
    };
  }

  async getOrderStatus(orderRef: string): Promise<SupplierOrderStatus> {
    // Ralawise API Reference v1.0.1 does not document a status endpoint.
    // Returning UNKNOWN keeps the placer worker happy without forcing
    // a fictional API call. If Ralawise add a status endpoint later,
    // wire it up here. See RALAWISE_API_NOTES.md.
    return {
      orderRef,
      status: 'UNKNOWN',
      raw: { note: 'Ralawise does not document an order-status endpoint' },
    };
  }

  async cancelOrder(orderRef: string): Promise<{ ok: boolean; reason?: string }> {
    // Ralawise API Reference v1.0.1 does not document a cancel endpoint.
    // Cancellation has to happen through the Ralawise web UI or via
    // ecommerce@ralawise.com.
    return {
      ok: false,
      reason: `Ralawise does not expose an order-cancel API; cancel ${orderRef} via the Ralawise website or by contacting ecommerce@ralawise.com.`,
    };
  }

  // ----------------------------------------------------------
  // HTTP plumbing
  // ----------------------------------------------------------

  /**
   * Issue a request with our error classification + token-refresh
   * retry. Use this for everything except the login call itself.
   */
  private async requestJson<T>(
    method: 'GET' | 'POST',
    url: string,
    body: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const doOnce = async (): Promise<Response> => {
      const token = await this.getValidToken();
      return this.fetchRaw(method, url, body, { token, timeoutMs: opts.timeoutMs });
    };

    let res = await doOnce();
    // 401 mid-request → cached token rejected. Drop + retry once.
    if (res.status === 401) {
      this.invalidateToken();
      res = await doOnce();
    }

    const text = await res.text().catch(() => '');
    const parsed = safeJsonParse<T>(text);

    if (res.status === 401 || res.status === 403) {
      throw new SupplierAuthError(`Ralawise auth failed (${res.status})`, {
        status: res.status,
        raw: parsed ?? text,
      });
    }
    if (res.status === 429) {
      // Rate-limited. Treat as upstream-retryable so the worker backs
      // off and retries, rather than as a permanent bad-request.
      throw new SupplierUpstreamError('Ralawise rate limit exceeded (429)', {
        status: 429,
        raw: parsed ?? text,
      });
    }
    if (res.status === 404) {
      // Not-found is mapped to bad-request so getStockForSku can
      // recognise it; the caller decides whether to swallow.
      throw new SupplierBadRequestError(`Ralawise 404: ${url}`, {
        status: 404,
        raw: parsed ?? text,
      });
    }
    if (res.status >= 400 && res.status < 500) {
      throw new SupplierBadRequestError(
        `Ralawise bad request (${res.status}): ${text.slice(0, 200)}`,
        { status: res.status, raw: parsed ?? text },
      );
    }
    if (res.status >= 500) {
      throw new SupplierUpstreamError(`Ralawise upstream ${res.status}`, {
        status: res.status,
        raw: parsed ?? text,
      });
    }
    if (parsed === undefined && text.length > 0) {
      throw new SupplierUpstreamError('Ralawise returned a non-JSON body', {
        status: res.status,
        raw: text,
      });
    }
    return (parsed ?? ({} as T));
  }

  /** Raw fetch with timeout + auth-aware header construction. Used
   *  by `requestJson` and directly by `refreshToken` (to avoid the
   *  token-refresh loop on the login call itself).
   *
   *  Honours `ctx.minRequestIntervalMs` to stay under supplier rate
   *  limits: waits until the throttle window has elapsed before
   *  issuing the request, then schedules the next allowed timestamp.
   *  Applies to ALL outbound calls (login + inventory + order) so
   *  the documented per-account rate limit isn't accidentally split
   *  across endpoints. */
  private async fetchRaw(
    method: 'GET' | 'POST',
    url: string,
    body: unknown,
    opts: { token?: string; auth?: boolean; timeoutMs?: number } = {},
  ): Promise<Response> {
    await this._awaitThrottle();
    // Stamp the NEXT allowed timestamp before issuing this request so
    // concurrent in-flight requests (rare, but possible) also wait.
    const interval = this.ctx.minRequestIntervalMs ?? 0;
    if (interval > 0) {
      this.nextRequestAllowedAt = Date.now() + interval;
    }
    const timeoutMs = opts.timeoutMs ?? this.ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false && opts.token) headers.Authorization = `Bearer ${opts.token}`;
    try {
      return await fetch(url, {
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
  }
}

// ============================================================
// Request shape mapping
// ============================================================

interface RalawiseOrderRequestBody {
  contactName: string;
  contactPhone?: string;
  orderReference: string;
  acceptTerms: true;
  orderNotes?: string;
  lineItems: Array<{
    sku: string;
    quantity: number;
    orderLineRef?: string;
    autoBackOrder: boolean;
  }>;
  delivery: {
    deliveryAddress: {
      deliveryAccountName: string;
      addressLine1: string;
      addressLine2?: string;
      townCity: string;
      postcode: string;
      countryCode: string;
      countryName?: string;
    };
    deliveryOption: {
      plainCover: boolean;
      deliveryMethod: string;
    };
  };
}

/**
 * Map our neutral order shape onto Ralawise's payload. Default
 * `plainCover=true` (customers don't see the supplier) and
 * `autoBackOrder=false` (failures surface immediately rather than
 * being silently queued at Ralawise). Both are documented in
 * RALAWISE_API_NOTES.md.
 *
 * `orderReference` is taken verbatim from `req.customerOrderRef` —
 * including the literal value `"APITEST"` if the caller wants a
 * test order. The connector does not auto-detect dev/staging and
 * never silently injects APITEST; production correctness wins. See
 * the notes for the rationale.
 *
 * The neutral `idempotencyKey` is forwarded as `orderLineRef` on
 * line items — Ralawise doesn't have an order-level idempotency
 * mechanism, but our supplier-orders table prevents double-placement
 * via its own deterministic key.
 */
export function mapOrderRequestToRalawise(req: SupplierOrderRequest): RalawiseOrderRequestBody {
  const orderReference = (req.customerOrderRef ?? '').slice(0, 20);
  if (!orderReference) {
    throw new SupplierBadRequestError('Ralawise order requires a non-empty customerOrderRef');
  }
  return {
    contactName: req.shipping.name,
    orderReference,
    acceptTerms: true,
    lineItems: req.lines.map((l) => ({
      sku: l.supplierSku,
      quantity: l.qty,
      orderLineRef: req.idempotencyKey.slice(0, 15),
      autoBackOrder: false,
    })),
    delivery: {
      deliveryAddress: {
        deliveryAccountName: req.shipping.name,
        addressLine1: req.shipping.line1,
        addressLine2: req.shipping.line2,
        townCity: req.shipping.city,
        postcode: req.shipping.postCode,
        countryCode: req.shipping.country,
        countryName: req.shipping.region,
      },
      deliveryOption: {
        plainCover: true,
        deliveryMethod: DEFAULT_DELIVERY_METHOD,
      },
    },
  };
}

// ============================================================
// JSON helper
// ============================================================

/** Like `JSON.parse(text)` but returns undefined on empty/non-JSON
 *  input instead of throwing. Mirrors the Uneek connector's helper
 *  but doesn't need the double-decode pass — Ralawise responds with
 *  plain JSON. */
function safeJsonParse<T>(text: string): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
