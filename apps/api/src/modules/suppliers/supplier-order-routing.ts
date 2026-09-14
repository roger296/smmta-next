/**
 * Turning a paid order's drop-ship lines into supplier orders (spec §7.2).
 *
 * One `supplier_orders` row per supplier on the order: the placer sends all of
 * that supplier's lines as one order, so each supplier ships one parcel. The
 * idempotency key is deterministic per (order, supplier), so a replayed
 * `order.paid` event never queues a second supplier order.
 */
import crypto from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { customerOrders, orderLines, supplierOrders } from '../../db/schema/index.js';

export function supplierOrderIdempotencyKey(customerOrderId: string, supplierId: string): string {
  return crypto.createHash('sha256').update(`supplier-order:${customerOrderId}:${supplierId}`).digest('hex');
}

export interface QueueSupplierOrdersResult {
  /** Rows created by this call; 0 on a replay. */
  queued: number;
  /** Every supplier the order's drop-ship lines go to. */
  supplierIds: string[];
}

/** Queue a PENDING supplier order for each supplier shipping part of the order. */
export async function queueSupplierOrders(
  orderId: string,
  companyId: string,
): Promise<QueueSupplierOrdersResult> {
  const db = getDb();
  const order = await db.query.customerOrders.findFirst({
    where: and(
      eq(customerOrders.id, orderId),
      eq(customerOrders.companyId, companyId),
      isNull(customerOrders.deletedAt),
    ),
    columns: { id: true, status: true },
  });
  // A cancelled order must not reach a supplier.
  if (!order || order.status === 'CANCELLED') return { queued: 0, supplierIds: [] };

  const rows = await db
    .selectDistinct({ supplierId: orderLines.supplierId })
    .from(orderLines)
    .where(
      and(
        eq(orderLines.orderId, orderId),
        eq(orderLines.fulfilmentSource, 'SUPPLIER'),
        isNotNull(orderLines.supplierId),
        isNull(orderLines.deletedAt),
      ),
    );
  const supplierIds = rows.map((r) => r.supplierId).filter((id): id is string => id !== null);
  if (supplierIds.length === 0) return { queued: 0, supplierIds };

  const inserted = await db
    .insert(supplierOrders)
    .values(
      supplierIds.map((supplierId) => ({
        companyId,
        customerOrderId: orderId,
        supplierId,
        idempotencyKey: supplierOrderIdempotencyKey(orderId, supplierId),
        status: 'PENDING' as const,
      })),
    )
    .onConflictDoNothing({ target: supplierOrders.idempotencyKey })
    .returning({ id: supplierOrders.id });
  return { queued: inserted.length, supplierIds };
}

/** Whether any of the order's lines ship from our own warehouse. */
export async function orderHasWarehouseLines(orderId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(
      and(
        eq(orderLines.orderId, orderId),
        eq(orderLines.fulfilmentSource, 'WAREHOUSE'),
        isNull(orderLines.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}
