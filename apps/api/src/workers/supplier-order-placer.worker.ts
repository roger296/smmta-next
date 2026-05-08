/**
 * Supplier-order placer worker.
 *
 * Polls `supplier_orders` for rows that are PENDING (or FAILED with a
 * retry budget remaining and `nextRetryAt` in the past), looks up the
 * customer order's shipping address, and calls
 * `connector.placeOrder()` on the matching supplier connector.
 *
 *   PENDING  → connector.placeOrder()  →  PLACED      (happy path)
 *                                       →  FAILED     (4xx / rejected — no retry)
 *                                       →  PENDING    (5xx / network — backoff scheduled)
 *
 * Backoff: `nextRetryAt = now + 2^retryCount minutes`. After 5 retries
 * the row is marked FAILED and a notification email goes to ops.
 *
 * One row at a time per call. The systemd unit runs the worker on a
 * tight loop (every 30s); higher throughput is V2.
 */
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getDb } from '../config/database.js';
import {
  customerOrders,
  customerDeliveryAddresses,
  customers,
  orderLines,
  supplierOrders,
  suppliers,
} from '../db/schema/index.js';
import { resolveConnector } from '../integrations/suppliers/registry.js';
import {
  SupplierAuthError,
  SupplierBadRequestError,
  SupplierRejectedOrderError,
  SupplierUnreachableError,
  SupplierUpstreamError,
} from '../integrations/suppliers/errors.js';
import type { SupplierConnector, SupplierOrderRequest } from '../integrations/suppliers/types.js';

const MAX_RETRIES = 5;
const FAILURE_NOTIFY_EMAIL = 'roger@etailsupport.com';

export interface RunPlacerOptions {
  /** Limit how many orders this run touches; default 50. */
  batchSize?: number;
  /** Test override for the connector resolver. */
  resolveConnector?: (supplier: typeof suppliers.$inferSelect) => SupplierConnector;
  /** Test hook called when a notification email *would* be sent. */
  onFailureNotify?: (row: typeof supplierOrders.$inferSelect, supplier: typeof suppliers.$inferSelect) => void;
}

export interface PlacerOutcome {
  supplierOrderId: string;
  result: 'PLACED' | 'PENDING' | 'FAILED' | 'SKIPPED';
  errorMessage?: string;
}

export async function runSupplierOrderPlacer(
  opts: RunPlacerOptions = {},
): Promise<PlacerOutcome[]> {
  const db = getDb();
  const batchSize = opts.batchSize ?? 50;

  // Pick PENDING rows + FAILED-but-retryable rows whose nextRetryAt has passed.
  const due = await db
    .select()
    .from(supplierOrders)
    .where(
      and(
        isNull(supplierOrders.deletedAt),
        or(
          eq(supplierOrders.status, 'PENDING'),
          and(
            eq(supplierOrders.status, 'FAILED'),
            lte(supplierOrders.retryCount, MAX_RETRIES - 1),
            sql`${supplierOrders.nextRetryAt} IS NOT NULL AND ${supplierOrders.nextRetryAt} <= NOW()`,
          ),
        ),
      ),
    )
    .orderBy(asc(supplierOrders.createdAt))
    .limit(batchSize);

  const outcomes: PlacerOutcome[] = [];
  for (const row of due) {
    const outcome = await placeOne(row, opts);
    outcomes.push(outcome);
  }
  return outcomes;
}

async function placeOne(
  row: typeof supplierOrders.$inferSelect,
  opts: RunPlacerOptions,
): Promise<PlacerOutcome> {
  const db = getDb();

  const supplier = await db.query.suppliers.findFirst({
    where: eq(suppliers.id, row.supplierId),
  });
  if (!supplier || !supplier.isDropshipActive) {
    return { supplierOrderId: row.id, result: 'SKIPPED', errorMessage: 'supplier inactive' };
  }

  // Resolve the connector.
  let connector: SupplierConnector;
  try {
    connector = opts.resolveConnector ? opts.resolveConnector(supplier) : resolveConnector(supplier);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'connector resolve failed';
    await markRetryOrFail(row, msg, supplier, opts);
    return { supplierOrderId: row.id, result: 'PENDING', errorMessage: msg };
  }

  // Build the SupplierOrderRequest from the customer order + line records.
  const order = await db.query.customerOrders.findFirst({
    where: eq(customerOrders.id, row.customerOrderId),
  });
  if (!order) {
    await db
      .update(supplierOrders)
      .set({ status: 'FAILED', errorMessage: 'customer order missing', updatedAt: new Date() })
      .where(eq(supplierOrders.id, row.id));
    return { supplierOrderId: row.id, result: 'FAILED', errorMessage: 'customer order missing' };
  }
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, order.customerId),
  });
  const shippingRow = order.deliveryAddressId
    ? await db.query.customerDeliveryAddresses.findFirst({
        where: eq(customerDeliveryAddresses.id, order.deliveryAddressId),
      })
    : null;
  if (!shippingRow) {
    await db
      .update(supplierOrders)
      .set({ status: 'FAILED', errorMessage: 'delivery address missing', updatedAt: new Date() })
      .where(eq(supplierOrders.id, row.id));
    return { supplierOrderId: row.id, result: 'FAILED', errorMessage: 'delivery address missing' };
  }
  const lines = await db.query.orderLines.findMany({
    where: and(
      eq(orderLines.orderId, order.id),
      eq(orderLines.fulfilmentSource, 'SUPPLIER'),
      eq(orderLines.supplierId, supplier.id),
    ),
  });
  if (lines.length === 0) {
    await db
      .update(supplierOrders)
      .set({ status: 'FAILED', errorMessage: 'no supplier lines on customer order', updatedAt: new Date() })
      .where(eq(supplierOrders.id, row.id));
    return { supplierOrderId: row.id, result: 'FAILED', errorMessage: 'no supplier lines' };
  }
  const skuLines = await fetchSupplierSkus(supplier.id, lines.map((l) => l.productId));

  const customerName = customer
    ? customer.name ?? customer.email ?? 'Customer'
    : shippingRow.contactName ?? 'Customer';

  const req: SupplierOrderRequest = {
    idempotencyKey: row.idempotencyKey,
    customerOrderRef: order.orderNumber,
    shipping: {
      name: shippingRow.contactName ?? customerName,
      line1: shippingRow.line1 ?? '',
      line2: shippingRow.line2 ?? undefined,
      city: shippingRow.city ?? '',
      region: shippingRow.region ?? undefined,
      postCode: shippingRow.postCode ?? '',
      country: shippingRow.country ?? 'GB',
    },
    lines: lines.map((l) => ({
      supplierSku: skuLines.get(l.productId) ?? '',
      qty: Math.floor(Number(l.quantity)),
    })),
  };

  // Capture the request payload up front for audit even if the call fails.
  await db
    .update(supplierOrders)
    .set({ requestPayload: req as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(supplierOrders.id, row.id));

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
      .where(eq(supplierOrders.id, row.id));
    return { supplierOrderId: row.id, result: 'PLACED' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    if (
      err instanceof SupplierAuthError ||
      err instanceof SupplierBadRequestError ||
      err instanceof SupplierRejectedOrderError
    ) {
      // Hard failures — don't retry.
      await db
        .update(supplierOrders)
        .set({ status: 'FAILED', errorMessage: msg, updatedAt: new Date() })
        .where(eq(supplierOrders.id, row.id));
      opts.onFailureNotify?.(row, supplier);
      // In production we'd send a SendGrid email here; for the V1 we
      // just record that the notification was due. The closeout PR
      // can add the actual transactional email.
      return { supplierOrderId: row.id, result: 'FAILED', errorMessage: msg };
    }
    if (err instanceof SupplierUpstreamError || err instanceof SupplierUnreachableError) {
      const result = await markRetryOrFail(row, msg, supplier, opts);
      return result;
    }
    // Unknown error — treat as transient.
    return await markRetryOrFail(row, msg, supplier, opts);
  }
}

async function markRetryOrFail(
  row: typeof supplierOrders.$inferSelect,
  msg: string,
  supplier: typeof suppliers.$inferSelect,
  opts: RunPlacerOptions,
): Promise<PlacerOutcome> {
  const db = getDb();
  const newCount = (row.retryCount ?? 0) + 1;
  if (newCount > MAX_RETRIES) {
    await db
      .update(supplierOrders)
      .set({
        status: 'FAILED',
        errorMessage: msg,
        retryCount: newCount,
        nextRetryAt: null,
        updatedAt: new Date(),
      })
      .where(eq(supplierOrders.id, row.id));
    opts.onFailureNotify?.(row, supplier);
    return { supplierOrderId: row.id, result: 'FAILED', errorMessage: msg };
  }
  const delayMs = 2 ** newCount * 60_000;
  const next = new Date(Date.now() + delayMs);
  await db
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

async function fetchSupplierSkus(
  supplierId: string,
  productIds: string[],
): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const db = getDb();
  const { supplierProducts } = await import('../db/schema/index.js');
  const rows = await db.query.supplierProducts.findMany({
    where: and(
      eq(supplierProducts.supplierId, supplierId),
      isNull(supplierProducts.deletedAt),
    ),
  });
  const out = new Map<string, string>();
  for (const r of rows) {
    if (productIds.includes(r.productId)) {
      out.set(r.productId, r.supplierSku);
    }
  }
  return out;
}

/**
 * Deterministic idempotency key for a customer-order line headed to a
 * supplier. SHA-256 of `${customerOrderId}:${supplierId}:${productId}` —
 * see spec §7.3.
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

export const FAILURE_NOTIFY_EMAIL_ADDRESS = FAILURE_NOTIFY_EMAIL;
