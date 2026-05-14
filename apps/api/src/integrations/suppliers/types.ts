/**
 * Drop-shipping supplier integration — contract types.
 *
 * Every connector module (uneek.connector.ts, future-supplier.connector.ts,
 * test stubs) implements `SupplierConnector`. The registry in `registry.ts`
 * maps a supplier row to its connector instance based on `connectorKind`.
 *
 * The shapes here are deliberately neutral — they represent what *we* need
 * from any supplier, not what any one supplier exposes. Each connector is
 * responsible for the field mapping between the upstream API and these
 * shapes.
 */

export interface SupplierStockSnapshot {
  /** The supplier's own SKU identifier (the one stored in
   *  `supplier_products.supplier_sku`). */
  supplierSku: string;
  /** Current available stock at the supplier, or null if the supplier
   *  doesn't recognise this SKU. Zero is a valid value (the SKU exists
   *  but is currently sold out). */
  stockQty: number | null;
  /** Wholesale / cost price in GBP (what we pay them). null if their API
   *  doesn't return a price or the field couldn't be parsed. */
  costGbp: number | null;
  /** Optional timestamp the supplier reports the snapshot was taken.
   *  Useful for reasoning about staleness; not required. */
  lastUpdatedAt?: Date;
}

export interface SupplierOrderShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postCode: string;
  country: string;
}

export interface SupplierOrderLine {
  supplierSku: string;
  qty: number;
}

export interface SupplierOrderRequest {
  /** Caller-generated key used for idempotent retries. The connector
   *  forwards this to the supplier in whatever header / field they
   *  support, or includes it in the request body when no native
   *  idempotency support exists. */
  idempotencyKey: string;
  /** Our customer-order reference, surfaced to the supplier so their
   *  ops team can correlate. */
  customerOrderRef: string;
  shipping: SupplierOrderShippingAddress;
  lines: SupplierOrderLine[];
}

export interface SupplierOrderResponse {
  /** The supplier's order number / reference. May be empty on REJECTED. */
  orderRef: string;
  status: 'ACCEPTED' | 'REJECTED';
  rejectionReason?: string;
  etaDays?: { min: number; max: number };
  /** Verbatim upstream response, for the audit log. */
  raw?: unknown;
}

export interface SupplierOrderStatus {
  orderRef: string;
  /** Supplier's own status string — connector-specific. The placer
   *  worker maps this to our `supplier_order_status` enum. */
  status: string;
  trackingCarrier?: string;
  trackingNumber?: string;
  shippedAt?: Date;
  deliveredAt?: Date;
  raw?: unknown;
}

export interface SupplierConnectorContext {
  /** Decrypted plaintext API key. The connector never sees the
   *  ciphertext on the row. */
  apiKey: string;
  apiBaseUrl: string;
  apiAuthScheme: string;
  /** Network timeout for individual requests. The connector may
   *  override this internally for slow endpoints (e.g. order placement). */
  timeoutMs?: number;
  /** Effective minimum milliseconds between consecutive HTTP requests
   *  issued by this connector — final number after deriving from the
   *  supplier row's `rate_limit_*` columns (or the `min_request_interval_ms`
   *  override). The registry computes this via `deriveMinRequestIntervalMs`
   *  so connectors only ever see one number. 0 / undefined = no throttle. */
  minRequestIntervalMs?: number;
}

/**
 * Derive the effective inter-request delay from a supplier row's
 * three rate-limit columns:
 *
 *   - When the operator has set an explicit override
 *     (`minRequestIntervalMs`), it wins. Used for the rare case where
 *     the supplier's published limit and the real-world limit differ.
 *
 *   - Otherwise, when both `rateLimitRequests` and
 *     `rateLimitWindowSeconds` are set, derive
 *       `intervalMs = ceil((windowSeconds * 1000 / requests) * SAFETY)`
 *     where SAFETY = 1.1 (10 % headroom). For Ralawise's 10/60 s ⇒
 *     6600 ms.
 *
 *   - Otherwise: no throttle (returns undefined).
 *
 * Always returns a positive integer or undefined — never zero, never
 * NaN, never negative.
 */
export const RATE_LIMIT_SAFETY_FACTOR = 1.1;

export function deriveMinRequestIntervalMs(input: {
  minRequestIntervalMs?: number | null;
  rateLimitRequests?: number | null;
  rateLimitWindowSeconds?: number | null;
}): number | undefined {
  if (
    typeof input.minRequestIntervalMs === 'number' &&
    input.minRequestIntervalMs > 0
  ) {
    return Math.ceil(input.minRequestIntervalMs);
  }
  const reqs = input.rateLimitRequests;
  const win = input.rateLimitWindowSeconds;
  if (
    typeof reqs === 'number' &&
    typeof win === 'number' &&
    reqs > 0 &&
    win > 0
  ) {
    // Compute via integer math so `6000 * 1.1` doesn't become
    // 6600.000000000001 (floating-point) and ceil up to 6601. SAFETY
    // is encoded as 11/10 — adjust the SAFETY_NUMERATOR/DENOMINATOR
    // if you ever want a different margin.
    const SAFETY_NUMERATOR = 11;
    const SAFETY_DENOMINATOR = 10;
    const num = win * 1000 * SAFETY_NUMERATOR;
    const den = reqs * SAFETY_DENOMINATOR;
    return Math.ceil(num / den);
  }
  return undefined;
}

export interface SupplierConnector {
  /**
   * Returns one snapshot per requested SKU. SKUs the supplier doesn't
   * recognise return null fields, not omitted entries — the polling
   * worker uses this to detect "your mapping references a SKU we
   * don't carry". If the supplier API requires batching, the
   * connector handles the chunking internally; the caller just
   * passes the full list.
   */
  getStockAndPrice(supplierSkus: string[]): Promise<SupplierStockSnapshot[]>;

  placeOrder(req: SupplierOrderRequest): Promise<SupplierOrderResponse>;

  getOrderStatus(orderRef: string): Promise<SupplierOrderStatus>;

  cancelOrder(orderRef: string): Promise<{ ok: boolean; reason?: string }>;
}
