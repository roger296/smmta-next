/**
 * Supplier-order placer.
 *
 * Sends PENDING `supplier_orders` rows to the supplier. Rows are queued by the
 * `create-supplier-orders` handler when an order is paid. The worker's placer
 * loop (SUPPLIER_ORDER_PLACING_ENABLED) runs a pass every minute, and
 * `scripts/run-supplier-order-placer.ts` runs one by hand.
 *
 *   PENDING → connector.placeOrder() → PLACED     (accepted)
 *                                    → FAILED     (refused, or the outcome is unknown)
 *                                    → PENDING    (certainly not sent; retried later)
 *                                    → CANCELLED  (the customer order was cancelled first)
 *
 * Never place an order twice. Neither Uneek nor Ralawise rejects a duplicate
 * order, so a row is only retried when the order certainly never arrived:
 *   - the connection was refused or the host not found, or the supplier
 *     answered 429 / 503 → retry after 2^n minutes, up to 5 times;
 *   - a timeout, a dropped connection or any other 5xx may have created the
 *     order → FAILED, and a person checks the supplier before pressing Retry;
 *   - a process that stopped mid-call leaves the request recorded with no
 *     outcome → the next pass marks it FAILED the same way.
 * Each attempt takes a 10-minute lease on the row (`nextRetryAt`), so two
 * processes never send the same row at once.
 *
 * Every row that ends FAILED emails SUPPLIER_ORDER_ALERT_EMAIL.
 */
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getDb } from '../config/database.js';
import { getEnv } from '../config/env.js';
import {
  customerOrders,
  customerDeliveryAddresses,
  orderLines,
  supplierOrders,
  supplierProducts,
  suppliers,
} from '../db/schema/index.js';
import { resolveConnector } from '../integrations/suppliers/registry.js';
import {
  SupplierAuthError,
  SupplierBadRequestError,
  SupplierError,
  SupplierRejectedOrderError,
  SupplierUnreachableError,
  SupplierUpstreamError,
} from '../integrations/suppliers/errors.js';
import type { SupplierConnector, SupplierOrderRequest } from '../integrations/suppliers/types.js';
import { getSendGrid } from '../integrations/sendgrid/sendgrid.js';

const MAX_RETRIES = 5;
/** How long one attempt holds a row. Longer than the slowest order call. */
const ATTEMPT_LEASE_MS = 10 * 60_000;

type SupplierOrderRow = typeof supplierOrders.$inferSelect;
type SupplierRow = typeof suppliers.$inferSelect;

export interface RunPlacerOptions {
  /** Limit how many orders this run touches; default 50. */
  batchSize?: number;
  /** Test override for the connector resolver. */
  resolveConnector?: (supplier: SupplierRow) => SupplierConnector;
  /** Replaces the alert email when a row ends FAILED; tests use it. */
  onFailureNotify?: (row: SupplierOrderRow, supplier: SupplierRow, reason: string) => void | Promise<void>;
}

export interface PlacerOutcome {
  supplierOrderId: string;
  result: 'PLACED' | 'PENDING' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
  errorMessage?: string;
}

export async function runSupplierOrderPlacer(
  opts: RunPlacerOptions = {},
): Promise<PlacerOutcome[]> {
  const db = getDb();
  const batchSize = opts.batchSize ?? 50;

  // PENDING rows that are not waiting out a backoff or another attempt's lease.
  const due = await db
    .select()
    .from(supplierOrders)
    .where(
      and(
        isNull(supplierOrders.deletedAt),
        eq(supplierOrders.status, 'PENDING'),
        or(isNull(supplierOrders.nextRetryAt), lte(supplierOrders.nextRetryAt, new Date())),
      ),
    )
    .orderBy(asc(supplierOrders.createdAt))
    .limit(batchSize);

  const outcomes: PlacerOutcome[] = [];
  for (const row of due) {
    outcomes.push(await placeOne(row, opts));
  }
  return outcomes;
}

/**
 * Whether a failed order call certainly never created the order, so sending
 * it again cannot make a duplicate.
 */
export function isSafeToRetry(err: unknown): boolean {
  if (err instanceof SupplierUpstreamError) return err.status === 429 || err.status === 503;
  if (err instanceof SupplierUnreachableError) {
    const raw = err.raw as { code?: unknown; cause?: { code?: unknown } } | undefined;
    const code = String(raw?.cause?.code ?? raw?.code ?? '');
    return NEVER_CONNECTED.has(code) || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(err.message);
  }
  return false;
}
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

async function placeOne(row: SupplierOrderRow, opts: RunPlacerOptions): Promise<PlacerOutcome> {
  const db = getDb();

  const supplier = await db.query.suppliers.findFirst({
    where: eq(suppliers.id, row.supplierId),
  });
  if (!supplier || !supplier.isDropshipActive) {
    return { supplierOrderId: row.id, result: 'SKIPPED', errorMessage: 'supplier inactive' };
  }

  // Claim the row for this attempt. Another process that got here first has
  // already moved nextRetryAt past now, so this update matches nothing.
  const [claimed] = await db
    .update(supplierOrders)
    .set({ nextRetryAt: new Date(Date.now() + ATTEMPT_LEASE_MS), updatedAt: new Date() })
    .where(
      and(
        eq(supplierOrders.id, row.id),
        eq(supplierOrders.status, 'PENDING'),
        or(isNull(supplierOrders.nextRetryAt), lte(supplierOrders.nextRetryAt, new Date())),
      ),
    )
    .returning();
  if (!claimed) {
    return { supplierOrderId: row.id, result: 'SKIPPED', errorMessage: 'being placed by another process' };
  }

  // A request recorded with no outcome: an earlier attempt stopped mid-call.
  if (claimed.requestPayload !== null && claimed.errorMessage === null) {
    return markFailed(
      claimed,
      supplier,
      `Outcome unknown: the order was sent to ${supplier.name} but no reply was recorded. Check ${supplier.name} for it before retrying.`,
      opts,
    );
  }

  let connector: SupplierConnector;
  try {
    connector = opts.resolveConnector ? opts.resolveConnector(supplier) : resolveConnector(supplier);
  } catch (err) {
    // Nothing was sent, so this is safe to retry.
    const msg = err instanceof Error ? err.message : 'connector resolve failed';
    return markRetryOrFail(claimed, msg, supplier, opts);
  }

  const order = await db.query.customerOrders.findFirst({
    where: eq(customerOrders.id, claimed.customerOrderId),
  });
  if (!order) return markFailed(claimed, supplier, 'The customer order is missing.', opts);
  if (order.status === 'CANCELLED') {
    const msg = 'The customer order was cancelled before it was sent to the supplier.';
    await db
      .update(supplierOrders)
      .set({ status: 'CANCELLED', errorMessage: msg, nextRetryAt: null, updatedAt: new Date() })
      .where(eq(supplierOrders.id, claimed.id));
    return { supplierOrderId: claimed.id, result: 'CANCELLED', errorMessage: msg };
  }
  const shippingRow = order.deliveryAddressId
    ? await db.query.customerDeliveryAddresses.findFirst({
        where: eq(customerDeliveryAddresses.id, order.deliveryAddressId),
      })
    : null;
  if (!shippingRow) return markFailed(claimed, supplier, 'The customer order has no delivery address.', opts);

  const lines = await db.query.orderLines.findMany({
    where: and(
      eq(orderLines.orderId, order.id),
      eq(orderLines.fulfilmentSource, 'SUPPLIER'),
      eq(orderLines.supplierId, supplier.id),
      isNull(orderLines.deletedAt),
    ),
  });
  if (lines.length === 0) {
    return markFailed(claimed, supplier, `The customer order has no lines for ${supplier.name}.`, opts);
  }
  const skus = await fetchSupplierSkus(supplier.id, lines.map((l) => l.productId));
  const unmapped = lines.filter((l) => !skus.get(l.productId));
  if (unmapped.length > 0) {
    return markFailed(
      claimed,
      supplier,
      `No ${supplier.name} SKU is mapped for product ${unmapped.map((l) => l.productId).join(', ')}.`,
      opts,
    );
  }

  const env = getEnv();
  const customer = await db.query.customers.findFirst({ where: (c, { eq: equals }) => equals(c.id, order.customerId) });
  const name = shippingRow.contactName ?? customer?.name ?? 'Customer';
  const req: SupplierOrderRequest = {
    idempotencyKey: claimed.idempotencyKey,
    customerOrderRef: order.orderNumber,
    shipping: {
      name,
      line1: shippingRow.line1 ?? '',
      line2: shippingRow.line2 ?? undefined,
      city: shippingRow.city ?? '',
      region: shippingRow.region ?? undefined,
      postCode: shippingRow.postCode ?? '',
      country: shippingRow.country ?? 'GB',
    },
    lines: lines.map((l) => ({
      supplierSku: skus.get(l.productId)!,
      qty: Math.floor(Number(l.quantity)),
    })),
    contactEmail: env.SUPPLIER_ORDER_CONTACT_EMAIL || undefined,
    contactPhone: shippingRow.phone ?? undefined,
  };

  // Recorded before the call and with no error, so a process that stops
  // mid-call leaves a request with no outcome for the next pass to flag.
  await db
    .update(supplierOrders)
    .set({
      requestPayload: req as unknown as Record<string, unknown>,
      responsePayload: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(supplierOrders.id, claimed.id));

  try {
    const resp = await connector.placeOrder(req);
    await db
      .update(supplierOrders)
      .set({
        status: 'PLACED',
        supplierOrderRef: resp.orderRef,
        responsePayload: resp as unknown as Record<string, unknown>,
        errorMessage: null,
        nextRetryAt: null,
        updatedAt: new Date(),
      })
      .where(eq(supplierOrders.id, claimed.id));
    return { supplierOrderId: claimed.id, result: 'PLACED' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    const raw = err instanceof SupplierError ? err.raw : undefined;
    if (isSafeToRetry(err)) {
      return markRetryOrFail({ ...claimed, requestPayload: req as unknown as Record<string, unknown> }, msg, supplier, opts);
    }
    if (
      err instanceof SupplierAuthError ||
      err instanceof SupplierBadRequestError ||
      err instanceof SupplierRejectedOrderError
    ) {
      return markFailed(claimed, supplier, `${supplier.name} did not accept the order: ${msg}`, opts, { raw });
    }
    return markFailed(
      claimed,
      supplier,
      `Outcome unknown: ${msg}. ${supplier.name} may have the order, so check before retrying.`,
      opts,
      { raw },
    );
  }
}

async function markRetryOrFail(
  row: SupplierOrderRow,
  msg: string,
  supplier: SupplierRow,
  opts: RunPlacerOptions,
): Promise<PlacerOutcome> {
  const newCount = (row.retryCount ?? 0) + 1;
  if (newCount > MAX_RETRIES) {
    return markFailed(row, supplier, `Not sent after ${MAX_RETRIES} retries: ${msg}`, opts, { retryCount: newCount });
  }
  const next = new Date(Date.now() + 2 ** newCount * 60_000);
  await getDb()
    .update(supplierOrders)
    .set({
      status: 'PENDING',
      retryCount: newCount,
      errorMessage: msg,
      nextRetryAt: next,
      updatedAt: new Date(),
    })
    .where(eq(supplierOrders.id, row.id));
  return { supplierOrderId: row.id, result: 'PENDING', errorMessage: msg };
}

async function markFailed(
  row: SupplierOrderRow,
  supplier: SupplierRow,
  reason: string,
  opts: RunPlacerOptions,
  extra: { retryCount?: number; raw?: unknown } = {},
): Promise<PlacerOutcome> {
  await getDb()
    .update(supplierOrders)
    .set({
      status: 'FAILED',
      errorMessage: reason,
      nextRetryAt: null,
      ...(extra.retryCount !== undefined ? { retryCount: extra.retryCount } : {}),
      ...(extra.raw !== undefined ? { responsePayload: { error: extra.raw } as Record<string, unknown> } : {}),
      updatedAt: new Date(),
    })
    .where(eq(supplierOrders.id, row.id));
  await notifyFailure(row, supplier, reason, opts);
  return { supplierOrderId: row.id, result: 'FAILED', errorMessage: reason };
}

async function notifyFailure(
  row: SupplierOrderRow,
  supplier: SupplierRow,
  reason: string,
  opts: RunPlacerOptions,
): Promise<void> {
  try {
    if (opts.onFailureNotify) {
      await opts.onFailureNotify(row, supplier, reason);
      return;
    }
    const order = await getDb().query.customerOrders.findFirst({
      where: eq(customerOrders.id, row.customerOrderId),
      columns: { orderNumber: true },
    });
    const orderNumber = order?.orderNumber ?? row.customerOrderId;
    await getSendGrid().send({
      to: getEnv().SUPPLIER_ORDER_ALERT_EMAIL,
      category: 'transactional',
      subject: `Supplier order needs attention: ${orderNumber} (${supplier.name})`,
      html: [
        `<p>The ${escapeHtml(supplier.name)} order for customer order <strong>${escapeHtml(orderNumber)}</strong> was not placed.</p>`,
        `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>`,
        `<p>Open Supplier orders in the admin to retry it once the problem is fixed. Supplier order id: ${escapeHtml(row.id)}.</p>`,
      ].join(''),
      idempotencyKey: `supplier-order-failed:${row.id}:${row.retryCount}:${row.updatedAt.getTime()}`,
    });
  } catch (err) {
    // The row is already FAILED and visible in the admin; a lost alert must
    // not stop the rest of the batch.
    // eslint-disable-next-line no-console
    console.error('[supplier-order-placer] failure alert not sent:', err);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function fetchSupplierSkus(
  supplierId: string,
  productIds: string[],
): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ productId: supplierProducts.productId, supplierSku: supplierProducts.supplierSku })
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.supplierId, supplierId),
        inArray(supplierProducts.productId, productIds),
        isNull(supplierProducts.deletedAt),
      ),
    );
  return new Map(rows.map((r) => [r.productId, r.supplierSku]));
}

/**
 * Deterministic idempotency key for a customer-order line headed to a
 * supplier. SHA-256 of `${customerOrderId}:${supplierId}:${productId}` —
 * see spec §7.3. New rows use `supplierOrderIdempotencyKey`, one per
 * (order, supplier), from `modules/suppliers/supplier-order-routing.ts`.
 */
export function buildIdempotencyKey(
  customerOrderId: string,
  supplierId: string,
  productId: string,
): string {
  const h = crypto.createHash('sha256');
  h.update(`${customerOrderId}:${supplierId}:${productId}`);
  return h.digest('hex');
}
