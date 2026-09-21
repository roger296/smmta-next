/**
 * Scanning serial-tracked units onto an order at despatch.
 *
 * The system allocates stock oldest first, but the picker takes whichever unit
 * is to hand, so the unit in the box is rarely the one allocated. For a product
 * that tracks serial numbers that matters: the record must say which unit went
 * to which customer. So each serial-tracked unit is scanned before the order
 * ships, and the scan makes the record match the box:
 *
 *   - the scanned unit is already on this order        -> marked scanned
 *   - it is free stock                                 -> it joins the order, and an
 *                                                         unscanned unit of the same
 *                                                         product goes back to stock
 *   - it is on another order, not yet scanned there    -> the two orders swap units
 *   - it is sold, written off, scanned elsewhere, or
 *     not a unit of anything on this order             -> refused, saying why
 *
 * An order never ends up with more units of a product than it asked for, and a
 * swap never leaves the other order short. Products that are not serial-tracked
 * are never scanned. Ship readiness (ship-order.service.ts) refuses to ship
 * until every serial-tracked unit on the order has been scanned.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { customerOrders, orderLines, products, stockItems } from '../../db/schema/index.js';

const SHIPPED_STATUSES = ['SHIPPED', 'PARTIALLY_SHIPPED', 'COMPLETED'];

export class SerialScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerialScanError';
  }
}

export class SerialScanNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'SerialScanNotFoundError';
  }
}

export interface SerialLineProgress {
  productId: string;
  sku: string | null;
  name: string;
  needed: number;
  scanned: Array<{ stockItemId: string; serialNumber: string; scannedAt: Date | null }>;
}

export interface SerialScanProgress {
  orderId: string;
  /** False when nothing on the order tracks serial numbers: there is nothing to scan. */
  required: boolean;
  complete: boolean;
  lines: SerialLineProgress[];
}

export type ScanOutcome = 'scanned' | 'swapped-from-stock' | 'swapped-with-order' | 'added';

export interface ScanResult {
  outcome: ScanOutcome;
  serialNumber: string;
  productName: string;
  /** In words, for the person scanning. */
  message: string;
  progress: SerialScanProgress;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class SerialScanService {
  private readonly db = getDb();

  constructor(private readonly deps: { now?: () => Date } = {}) {}

  async progress(orderId: string, companyId: string): Promise<SerialScanProgress> {
    const order = await this.db.query.customerOrders.findFirst({
      where: and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)),
      with: { lines: { where: isNull(orderLines.deletedAt), with: { product: true } } },
    });
    if (!order) throw new SerialScanNotFoundError(orderId);

    const lines = new Map<string, SerialLineProgress>();
    for (const line of order.lines) {
      if (!line.product?.requireSerialNumber || line.fulfilmentSource === 'SUPPLIER') continue;
      const entry = lines.get(line.productId) ?? {
        productId: line.productId,
        sku: line.product.stockCode ?? null,
        name: line.product.name,
        needed: 0,
        scanned: [],
      };
      entry.needed += Math.ceil(Number(line.quantity) || 0);
      lines.set(line.productId, entry);
    }

    if (lines.size > 0) {
      const rows = await this.db
        .select({ id: stockItems.id, productId: stockItems.productId, serialNumber: stockItems.serialNumber, scannedAt: stockItems.scannedAt })
        .from(stockItems)
        .where(
          and(
            eq(stockItems.companyId, companyId),
            eq(stockItems.salesOrderId, orderId),
            sql`${stockItems.scannedAt} IS NOT NULL`,
            isNull(stockItems.deletedAt),
          ),
        )
        .orderBy(asc(stockItems.scannedAt));
      for (const row of rows) {
        lines.get(row.productId)?.scanned.push({ stockItemId: row.id, serialNumber: row.serialNumber ?? '', scannedAt: row.scannedAt });
      }
    }

    const list = [...lines.values()];
    return {
      orderId,
      required: list.length > 0,
      complete: list.every((l) => l.scanned.length >= l.needed),
      lines: list,
    };
  }

  /** What still needs scanning, in words for ship readiness. Empty when there is nothing left. */
  async outstanding(orderId: string, companyId: string): Promise<string[]> {
    const progress = await this.progress(orderId, companyId);
    return progress.lines
      .filter((l) => l.scanned.length < l.needed)
      .map((l) => `Scan serial numbers: ${l.scanned.length} of ${plural(l.needed, 'unit')} of ${l.sku ?? l.name} scanned.`);
  }

  async scan(orderId: string, companyId: string, code: string, userId?: string | null): Promise<ScanResult> {
    const serial = code.trim();
    if (!serial) throw new SerialScanError('Scan or type a serial number.');
    const now = this.deps.now?.() ?? new Date();

    const result = await this.db.transaction(async (tx) => {
      // The order is locked, so two people scanning the same order take turns.
      const [order] = await tx
        .select({ status: customerOrders.status })
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)))
        .for('update');
      if (!order) throw new SerialScanNotFoundError(orderId);
      if (SHIPPED_STATUSES.includes(order.status)) throw new SerialScanError('This order has already been shipped.');
      if (order.status === 'CANCELLED') throw new SerialScanError('This order is cancelled.');

      const lines = await tx
        .select({ productId: orderLines.productId, quantity: orderLines.quantity, name: products.name, tracked: products.requireSerialNumber })
        .from(orderLines)
        .innerJoin(products, eq(products.id, orderLines.productId))
        .where(and(eq(orderLines.orderId, orderId), isNull(orderLines.deletedAt), eq(orderLines.fulfilmentSource, 'WAREHOUSE')));
      const tracked = lines.filter((l) => l.tracked);
      if (tracked.length === 0) throw new SerialScanError('Nothing on this order needs its serial number scanned.');

      // The unit, among the products on this order. Locked: a unit is scanned onto one order.
      const candidates = await tx
        .select()
        .from(stockItems)
        .where(
          and(
            eq(stockItems.companyId, companyId),
            sql`lower(${stockItems.serialNumber}) = ${serial.toLowerCase()}`,
            isNull(stockItems.deletedAt),
          ),
        )
        .for('update');
      const unit = candidates.find((c) => tracked.some((l) => l.productId === c.productId));
      if (!unit) {
        throw new SerialScanError(
          candidates.length > 0
            ? `${serial} is a unit of a product that is not on this order.`
            : `${serial} is not a serial number in the system.`,
        );
      }

      const productName = tracked.find((l) => l.productId === unit.productId)!.name;
      const needed = tracked.filter((l) => l.productId === unit.productId).reduce((n, l) => n + Math.ceil(Number(l.quantity) || 0), 0);
      const onOrder = await tx
        .select()
        .from(stockItems)
        .where(
          and(
            eq(stockItems.companyId, companyId),
            eq(stockItems.salesOrderId, orderId),
            eq(stockItems.productId, unit.productId),
            eq(stockItems.status, 'ALLOCATED'),
            isNull(stockItems.deletedAt),
          ),
        )
        .orderBy(asc(stockItems.createdAt))
        .for('update');
      const scannedCount = onOrder.filter((u) => u.scannedAt).length;
      const unscanned = onOrder.filter((u) => !u.scannedAt && u.id !== unit.id);

      const markScanned = (id: string, extra: Partial<typeof stockItems.$inferInsert> = {}) =>
        tx.update(stockItems).set({ ...extra, scannedAt: now, scannedBy: userId ?? null, updatedAt: now }).where(eq(stockItems.id, id));

      // Already on this order.
      if (unit.salesOrderId === orderId && unit.status === 'ALLOCATED') {
        if (unit.scannedAt) throw new SerialScanError(`${serial} has already been scanned onto this order.`);
        await markScanned(unit.id);
        return { outcome: 'scanned' as const, productName, message: `${serial} scanned.` };
      }

      if (scannedCount >= needed) {
        throw new SerialScanError(`Every unit of ${productName} on this order has been scanned already.`);
      }

      // Free stock: it takes the place of a unit the system had allocated.
      if (unit.status === 'IN_STOCK' && !unit.salesOrderId && !unit.reservationId) {
        const displaced = unscanned[0];
        if (displaced) {
          await tx
            .update(stockItems)
            .set({ status: 'IN_STOCK', salesOrderId: null, updatedAt: now })
            .where(eq(stockItems.id, displaced.id));
        } else if (onOrder.length >= needed) {
          // Cannot happen while scannedCount < needed, but never over-allocate.
          throw new SerialScanError(`This order already has all its units of ${productName}.`);
        }
        await markScanned(unit.id, { status: 'ALLOCATED', salesOrderId: orderId });
        return displaced
          ? { outcome: 'swapped-from-stock' as const, productName, message: `${serial} scanned. It replaces ${displaced.serialNumber ?? 'an unscanned unit'}, which is back in stock.` }
          : { outcome: 'added' as const, productName, message: `${serial} scanned and allocated to this order.` };
      }

      // On another order: the two orders swap, so neither is left short.
      if (unit.status === 'ALLOCATED' && unit.salesOrderId && unit.salesOrderId !== orderId) {
        if (unit.scannedAt) throw new SerialScanError(`${serial} has already been scanned onto another order.`);
        const displaced = unscanned[0];
        if (!displaced) {
          throw new SerialScanError(
            `${serial} is allocated to another order, and this order has no unscanned unit of ${productName} to give it in exchange. Allocate stock to this order first.`,
          );
        }
        await tx.update(stockItems).set({ salesOrderId: unit.salesOrderId, updatedAt: now }).where(eq(stockItems.id, displaced.id));
        await markScanned(unit.id, { salesOrderId: orderId });
        return { outcome: 'swapped-with-order' as const, productName, message: `${serial} scanned. It was on another order, which now has ${displaced.serialNumber ?? 'another unit'} instead.` };
      }

      const why =
        unit.status === 'SOLD' ? 'has already been sold' : unit.status === 'RESERVED' || unit.reservationId ? 'is reserved for a checkout in progress' : `is ${unit.status.toLowerCase().replace(/_/g, ' ')}`;
      throw new SerialScanError(`${serial} ${why}, so it cannot go on this order.`);
    });

    return { ...result, serialNumber: serial, progress: await this.progress(orderId, companyId) };
  }

  /** Takes a scan back. The unit stays allocated to the order; it just needs scanning again (or swapping). */
  async unscan(orderId: string, companyId: string, stockItemId: string): Promise<SerialScanProgress> {
    const [order] = await this.db
      .select({ status: customerOrders.status })
      .from(customerOrders)
      .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)))
      .limit(1);
    if (!order) throw new SerialScanNotFoundError(orderId);
    if (SHIPPED_STATUSES.includes(order.status)) throw new SerialScanError('This order has already been shipped.');

    await this.db
      .update(stockItems)
      .set({ scannedAt: null, scannedBy: null, updatedAt: this.deps.now?.() ?? new Date() })
      .where(and(eq(stockItems.id, stockItemId), eq(stockItems.salesOrderId, orderId), eq(stockItems.companyId, companyId)));
    return this.progress(orderId, companyId);
  }
}
