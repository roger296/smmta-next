/**
 * ReservationService — locking allocator for the storefront.
 *
 * Concurrency model
 *   The hot path is `createReservation`. Inside a single transaction we
 *   `SELECT ... FOR UPDATE SKIP LOCKED` against `stock_items` to claim
 *   exactly the requested quantity. Two concurrent reservations for the
 *   last N units of a product pick up disjoint rows; the loser, finding
 *   too few rows under its lock, rolls back with `InsufficientStockError`.
 *
 * Lifecycle
 *   HELD ── createReservation ──> committed reservation, items RESERVED
 *   HELD ── releaseReservation ──> RELEASED, items back to IN_STOCK
 *   HELD ── convertReservation ──> CONVERTED, items ALLOCATED to order
 *   HELD ── expireReservations  ──> EXPIRED, items back to IN_STOCK
 *
 * Anything not in HELD is a no-op for release and a hard failure for convert.
 *
 * Drop-ship lines
 *   A product with no free warehouse stock can still be reserved when a
 *   supplier holds enough above its stock buffer. No stock_items are held
 *   for it; the chosen supplier is kept in `metadata.supplierLines` and the
 *   order line is created with fulfilmentSource SUPPLIER on convert.
 */
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  customerOrders,
  orderLines,
  stockItems,
  stockReservations,
  type ReservationMetadata,
  type ReservationSupplierLine,
} from '../../db/schema/index.js';
import { emitDomainEvent } from '../../shared/events/emit.js';
import { OrderHoldService } from '../orders/order-hold.service.js';
import { bestSupplierAvailable, pickSupplierForProduct } from '../suppliers/pick-supplier.js';
import type { DeliveryQuote } from '../../db/schema/index.js';
import { quoteDeliveryForLines } from './delivery.js';

// ---------------------------------------------------------------------------
// Types and errors
// ---------------------------------------------------------------------------

export interface ReservationLineInput {
  productId: string;
  quantity: number;
}

export interface CreateReservationInput {
  items: ReservationLineInput[];
  ttlSeconds: number;
  /** Optional source channel override; defaults to API. */
  sourceChannel?: 'API';
  metadata?: ReservationMetadata;
  /** The storefront's standard delivery rate. When given, the reservation
   *  quotes the delivery charge per parcel (see delivery.ts), returns it, and
   *  the order is committed with that charge. */
  defaultDeliveryChargeGbp?: string;
}

export interface ReservationLineResult {
  productId: string;
  quantity: number;
  /** WAREHOUSE lines hold stock_items; SUPPLIER lines hold none. */
  source: 'WAREHOUSE' | 'SUPPLIER';
  /** The supplier a SUPPLIER line will be ordered from. */
  supplierId?: string;
  /** IDs of the stock_items rows held for this line (empty for SUPPLIER). */
  stockItemIds: string[];
}

export interface ReservationResult {
  reservationId: string;
  expiresAt: Date;
  status: 'HELD';
  lines: ReservationLineResult[];
  /** Null unless the caller passed defaultDeliveryChargeGbp. */
  delivery: DeliveryQuote | null;
}

export class InsufficientStockError extends Error {
  readonly productId: string;
  /** Units we managed to lock under SKIP LOCKED at the moment of failure. */
  readonly available: number;
  readonly requested: number;
  constructor(productId: string, available: number, requested: number) {
    super(
      `Insufficient stock for product ${productId}: requested ${requested}, available ${available}`,
    );
    this.name = 'InsufficientStockError';
    this.productId = productId;
    this.available = available;
    this.requested = requested;
  }
}

export class ReservationStateError extends Error {
  readonly reservationId: string;
  readonly currentStatus: string;
  constructor(reservationId: string, currentStatus: string, expected: string) {
    super(
      `Reservation ${reservationId} is in status ${currentStatus}; expected ${expected}`,
    );
    this.name = 'ReservationStateError';
    this.reservationId = reservationId;
    this.currentStatus = currentStatus;
  }
}

// Inputs for convertReservation. The caller (Prompt 5's order-commit
// service) is responsible for resolving customer/address rows and computing
// line prices server-side.
export interface ConvertOrderInputs {
  orderNumber: string;
  customerId: string;
  warehouseId?: string;
  contactId?: string;
  invoiceAddressId?: string;
  deliveryAddressId?: string;
  orderDate: string; // YYYY-MM-DD
  thirdPartyOrderId?: string;
  integrationMetadata?: Record<string, unknown>;
  vatTreatment?:
    | 'STANDARD_VAT_20'
    | 'REDUCED_VAT_5'
    | 'ZERO_RATED'
    | 'EXEMPT'
    | 'OUTSIDE_SCOPE'
    | 'REVERSE_CHARGE'
    | 'POSTPONED_VAT';
  totals: {
    deliveryCharge?: string;
    orderTotal: string;
    taxTotal: string;
    grandTotal: string;
  };
  /** Line price snapshots keyed by productId. The caller is responsible
   *  for computing these consistently with the storefront's price snapshot. */
  linePrices: Record<
    string,
    {
      pricePerUnit: string;
      lineTotal: string;
      taxName?: string;
      taxRate?: number;
      taxValue?: string;
    }
  >;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ReservationService {
  private db = getDb();

  /** Reserve stock for a basket of `{ productId, quantity }` lines. */
  async createReservation(
    companyId: string,
    input: CreateReservationInput,
  ): Promise<ReservationResult> {
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

    // One line per product: all of a product's units come from one source,
    // and the order is priced per product.
    const qtyByProduct = new Map<string, number>();
    for (const item of input.items) {
      if (item.quantity <= 0 || !Number.isInteger(item.quantity)) {
        throw new Error(`Invalid quantity for product ${item.productId}: ${item.quantity}`);
      }
      qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + item.quantity);
    }

    return this.db.transaction(async (tx) => {
      const [reservation] = await tx
        .insert(stockReservations)
        .values({
          companyId,
          sourceChannel: input.sourceChannel ?? 'API',
          status: 'HELD',
          expiresAt,
          metadata: input.metadata ?? null,
        })
        .returning();
      if (!reservation) throw new Error('Failed to insert stock_reservations row');

      const lines: ReservationLineResult[] = [];
      const supplierLines: ReservationSupplierLine[] = [];

      for (const [productId, quantity] of qtyByProduct) {
        // Atomically grab up to `quantity` IN_STOCK rows under
        // SELECT ... FOR UPDATE SKIP LOCKED, ordered by created_at to keep
        // FIFO behaviour with the rest of the codebase.
        const picked = await tx
          .select({ id: stockItems.id })
          .from(stockItems)
          .where(
            and(
              eq(stockItems.companyId, companyId),
              eq(stockItems.productId, productId),
              eq(stockItems.status, 'IN_STOCK'),
              isNull(stockItems.deletedAt),
            ),
          )
          .orderBy(stockItems.createdAt)
          .limit(quantity)
          .for('update', { skipLocked: true });

        if (picked.length === quantity) {
          const ids = picked.map((r) => r.id);
          await tx
            .update(stockItems)
            .set({
              status: 'RESERVED',
              reservationId: reservation.id,
              updatedAt: new Date(),
            })
            .where(inArray(stockItems.id, ids));

          lines.push({ productId, quantity, source: 'WAREHOUSE', stockItemIds: ids });
          continue;
        }

        // The transaction rolls back automatically on throw; the
        // reservation row insert is undone too.
        if (picked.length > 0) {
          // V1 never splits a line between the warehouse and a supplier
          // (spec §7.1), so a part-stocked line is refused.
          throw new InsufficientStockError(productId, picked.length, quantity);
        }

        const supplier = await pickSupplierForProduct(companyId, productId, quantity, tx);
        if (!supplier) {
          const available = await bestSupplierAvailable(companyId, productId, tx);
          throw new InsufficientStockError(productId, available, quantity);
        }
        supplierLines.push({ productId, quantity, supplierId: supplier.supplierId });
        lines.push({
          productId,
          quantity,
          source: 'SUPPLIER',
          supplierId: supplier.supplierId,
          stockItemIds: [],
        });
      }

      // Quoted from where each line actually ships from, and kept with the
      // reservation so the order is committed with exactly this charge.
      const delivery = input.defaultDeliveryChargeGbp
        ? await quoteDeliveryForLines(companyId, lines, input.defaultDeliveryChargeGbp, tx)
        : null;

      if (supplierLines.length > 0 || delivery) {
        await tx
          .update(stockReservations)
          .set({
            metadata: {
              ...(input.metadata ?? {}),
              ...(supplierLines.length > 0 ? { supplierLines } : {}),
              ...(delivery ? { delivery } : {}),
            },
          })
          .where(eq(stockReservations.id, reservation.id));
      }

      return {
        reservationId: reservation.id,
        expiresAt: reservation.expiresAt,
        status: 'HELD' as const,
        lines,
        delivery,
      };
    });
  }

  /**
   * Release a HELD reservation. Idempotent: returning RELEASED|CONVERTED|EXPIRED
   * rows untouched and reporting the current status. A miss returns null.
   */
  async releaseReservation(
    id: string,
    companyId: string,
  ): Promise<{ status: 'RELEASED' | 'CONVERTED' | 'EXPIRED' | 'NOT_FOUND' }> {
    return this.db.transaction(async (tx) => {
      const reservation = await tx.query.stockReservations.findFirst({
        where: and(
          eq(stockReservations.id, id),
          eq(stockReservations.companyId, companyId),
          isNull(stockReservations.deletedAt),
        ),
      });
      if (!reservation) return { status: 'NOT_FOUND' as const };
      if (reservation.status !== 'HELD') {
        return { status: reservation.status };
      }

      await tx
        .update(stockItems)
        .set({ status: 'IN_STOCK', reservationId: null, updatedAt: new Date() })
        .where(
          and(
            eq(stockItems.reservationId, id),
            eq(stockItems.status, 'RESERVED'),
            isNull(stockItems.deletedAt),
          ),
        );

      await tx
        .update(stockReservations)
        .set({ status: 'RELEASED', updatedAt: new Date() })
        .where(eq(stockReservations.id, id));

      return { status: 'RELEASED' as const };
    });
  }

  /**
   * Convert a HELD reservation into a CONFIRMED + ALLOCATED order. The
   * caller (storefront `order-commit.service.ts` in Prompt 5) is
   * responsible for customer/address resolution and price computation.
   */
  async convertReservation(
    id: string,
    companyId: string,
    inputs: ConvertOrderInputs,
  ): Promise<{ orderId: string }> {
    return this.db.transaction(async (tx) => {
      const reservation = await tx.query.stockReservations.findFirst({
        where: and(
          eq(stockReservations.id, id),
          eq(stockReservations.companyId, companyId),
          isNull(stockReservations.deletedAt),
        ),
      });
      if (!reservation) throw new ReservationStateError(id, 'NOT_FOUND', 'HELD');
      if (reservation.status !== 'HELD') {
        throw new ReservationStateError(id, reservation.status, 'HELD');
      }

      // Insert customerOrder.
      const [order] = await tx
        .insert(customerOrders)
        .values({
          companyId,
          orderNumber: inputs.orderNumber,
          customerId: inputs.customerId,
          contactId: inputs.contactId ?? null,
          invoiceAddressId: inputs.invoiceAddressId ?? null,
          deliveryAddressId: inputs.deliveryAddressId ?? null,
          warehouseId: inputs.warehouseId ?? null,
          orderDate: inputs.orderDate,
          deliveryCharge: inputs.totals.deliveryCharge ?? '0',
          orderTotal: inputs.totals.orderTotal,
          taxTotal: inputs.totals.taxTotal,
          grandTotal: inputs.totals.grandTotal,
          status: 'ALLOCATED',
          sourceChannel: 'API',
          integrationMetadata: inputs.integrationMetadata ?? null,
          thirdPartyOrderId: inputs.thirdPartyOrderId ?? null,
          ...(inputs.vatTreatment ? { vatTreatment: inputs.vatTreatment } : {}),
        })
        .returning();
      if (!order) throw new Error('Failed to insert customerOrder');

      // Build orderLines from the held stock items.
      const heldItems = await tx
        .select({ productId: stockItems.productId, id: stockItems.id })
        .from(stockItems)
        .where(
          and(
            eq(stockItems.reservationId, id),
            eq(stockItems.status, 'RESERVED'),
            isNull(stockItems.deletedAt),
          ),
        );

      const grouped = new Map<string, string[]>();
      for (const r of heldItems) {
        const arr = grouped.get(r.productId) ?? [];
        arr.push(r.id);
        grouped.set(r.productId, arr);
      }

      const lineRow = (productId: string, quantity: number) => {
        const price = inputs.linePrices[productId];
        if (!price) {
          throw new Error(
            `convertReservation: missing line price snapshot for product ${productId}`,
          );
        }
        return {
          orderId: order.id,
          productId,
          quantity,
          pricePerUnit: price.pricePerUnit,
          lineTotal: price.lineTotal,
          taxName: price.taxName ?? null,
          taxRate: price.taxRate ?? 0,
          taxValue: price.taxValue ?? '0',
        };
      };
      const lineRows: Array<typeof orderLines.$inferInsert> = Array.from(grouped.entries()).map(
        ([productId, ids]) => ({ ...lineRow(productId, ids.length), fulfilmentSource: 'WAREHOUSE' }),
      );
      // Drop-shipped lines hold no stock; their supplier was chosen when the
      // reservation was made, and the supplier order is placed from this line.
      for (const line of reservation.metadata?.supplierLines ?? []) {
        lineRows.push({
          ...lineRow(line.productId, line.quantity),
          fulfilmentSource: 'SUPPLIER',
          supplierId: line.supplierId,
        });
      }
      if (lineRows.length > 0) {
        await tx.insert(orderLines).values(lineRows);
      }

      // Any extension that holds new orders is asked about this one too, before
      // order.paid, so the label and pick note that event asks for find the hold.
      await new OrderHoldService().applyChecks(tx, {
        id: order.id,
        companyId,
        orderNumber: inputs.orderNumber,
        warehouseId: order.warehouseId,
        customerId: order.customerId,
        sourceChannel: order.sourceChannel,
        grandTotal: order.grandTotal,
      });

      // A storefront order only exists once Mollie has confirmed payment, so this
      // is the moment it is paid. Emitted inside the same transaction: if the
      // order rolls back, the event never happened. Reactions (a shipping label
      // today) run from the outbox dispatcher, so a slow or failing carrier API
      // can never delay or break checkout.
      await emitDomainEvent(tx, {
        companyId,
        eventType: 'order.paid',
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { orderId: order.id, orderNumber: inputs.orderNumber, source: 'storefront' },
      });

      // Flip stock items to ALLOCATED, link to the order, clear reservation.
      await tx
        .update(stockItems)
        .set({
          status: 'ALLOCATED',
          salesOrderId: order.id,
          reservationId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stockItems.reservationId, id),
            eq(stockItems.status, 'RESERVED'),
            isNull(stockItems.deletedAt),
          ),
        );

      await tx
        .update(stockReservations)
        .set({ status: 'CONVERTED', updatedAt: new Date() })
        .where(eq(stockReservations.id, id));

      return { orderId: order.id };
    });
  }

  /**
   * Find any HELD reservations whose `expires_at` has passed, revert their
   * stock items to IN_STOCK, and mark the reservation EXPIRED. Returns the
   * count of reservations expired.
   */
  async expireReservations(now: Date = new Date()): Promise<number> {
    return this.db.transaction(async (tx) => {
      const expired = await tx
        .select({ id: stockReservations.id })
        .from(stockReservations)
        .where(
          and(
            eq(stockReservations.status, 'HELD'),
            lt(stockReservations.expiresAt, now),
            isNull(stockReservations.deletedAt),
          ),
        )
        .for('update', { skipLocked: true });

      if (expired.length === 0) return 0;
      const ids = expired.map((r) => r.id);

      await tx
        .update(stockItems)
        .set({ status: 'IN_STOCK', reservationId: null, updatedAt: new Date() })
        .where(
          and(
            inArray(stockItems.reservationId, ids),
            eq(stockItems.status, 'RESERVED'),
            isNull(stockItems.deletedAt),
          ),
        );

      await tx
        .update(stockReservations)
        .set({ status: 'EXPIRED', updatedAt: new Date() })
        .where(inArray(stockReservations.id, ids));

      return expired.length;
    });
  }
}

// ---------------------------------------------------------------------------
// Expiry interval — module-level state to ensure a single timer per process.
// ---------------------------------------------------------------------------

let expiryTimer: NodeJS.Timeout | null = null;

/**
 * Start a 60-second polling loop that calls `expireReservations`. Idempotent:
 * calling start twice keeps a single timer running. TODO: migrate to a BullMQ
 * job on the existing Redis instance once we add a worker process.
 */
export function startReservationExpiryLoop(intervalMs = 60_000): void {
  if (expiryTimer) return;
  const service = new ReservationService();
  expiryTimer = setInterval(() => {
    service.expireReservations().catch((err) => {
      // Log and swallow — a transient DB error shouldn't kill the process.
      // The Fastify app's logger isn't easily reachable here; falling back
      // to console is acceptable for a v1 in-process scheduler.
      // eslint-disable-next-line no-console
      console.error('[reservation-expiry] failed:', err);
    });
  }, intervalMs);
  // Don't keep the process alive purely on this timer.
  expiryTimer.unref?.();
}

/** Stop the expiry loop (mainly used by tests and graceful shutdown). */
export function stopReservationExpiryLoop(): void {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}
