/**
 * Order holds: reasons an order may not go to the warehouse yet.
 *
 * A held order keeps its status and is allocated stock as usual, but gets no
 * pick note and no shipping label and cannot be shipped. Releasing its last
 * hold emits order.released, which makes the documents it was denied.
 *
 * Holds come from two places:
 *   - a person, from the order page (holder key 'manual');
 *   - hold checks: functions registered by an extension (see
 *     apps/api/src/extensions) that are asked about every new order, inside the
 *     transaction that creates it, and may answer with a hold. That is how a
 *     business puts its own sign-off steps in front of the warehouse without the
 *     core knowing what they are.
 *
 * Each holder releases only its own hold; an order is free when none are left.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { customerOrders, orderHolds } from '../../db/schema/index.js';
import { emitDomainEvent, type DbTx } from '../../shared/events/emit.js';

export const MANUAL_HOLDER = 'manual';

type Db = ReturnType<typeof getDb>;
/** The database, or a transaction on it. */
export type DbOrTx = Db | DbTx;

export type OrderHold = typeof orderHolds.$inferSelect;

export interface NewOrderForHoldCheck {
  id: string;
  companyId: string;
  orderNumber: string;
  warehouseId: string | null;
  customerId: string;
  sourceChannel: string;
  grandTotal: string | null;
}

/** Answers with a hold to place on a new order, or null to let it through. */
export type OrderHoldCheck = (
  tx: DbTx,
  order: NewOrderForHoldCheck,
) => Promise<{ holderKey: string; reason: string } | null>;

const holdChecks: OrderHoldCheck[] = [];

/** Called by an extension at start-up. Checks run in the order they were registered. */
export function registerOrderHoldCheck(check: OrderHoldCheck): void {
  holdChecks.push(check);
}

/** For tests. */
export function clearOrderHoldChecks(): void {
  holdChecks.length = 0;
}

export class OrderHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderHoldError';
  }
}

/** The order is on hold, so it gets no pick note or label and cannot ship. */
export class OrderHeldError extends Error {
  constructor(readonly reasons: string[]) {
    super(`This order is on hold. ${reasons.join(' ')}`.trim());
    this.name = 'OrderHeldError';
  }
}

export class OrderHoldService {
  private readonly db = getDb();

  /** Runs every registered check against a new order, inside its creating transaction. */
  async applyChecks(tx: DbTx, order: NewOrderForHoldCheck): Promise<OrderHold[]> {
    const placed: OrderHold[] = [];
    for (const check of holdChecks) {
      const wanted = await check(tx, order);
      if (wanted) placed.push(await this.place(order.id, order.companyId, wanted.holderKey, wanted.reason, { tx }));
    }
    return placed;
  }

  /** Places the holder's hold, or updates its reason if it already has one. */
  async place(
    orderId: string,
    companyId: string,
    holderKey: string,
    reason: string,
    opts: { tx?: DbTx; userId?: string | null } = {},
  ): Promise<OrderHold> {
    const text = reason.trim().slice(0, 300);
    if (!text) throw new OrderHoldError('Say why the order is on hold.');
    const run = async (tx: DbTx) => {
      const [order] = await tx
        .select({ status: customerOrders.status })
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)))
        .limit(1);
      if (!order) throw new OrderHoldError('Order not found.');
      if (['SHIPPED', 'PARTIALLY_SHIPPED', 'COMPLETED'].includes(order.status)) {
        throw new OrderHoldError('This order has already been shipped.');
      }

      const [existing] = await tx
        .select()
        .from(orderHolds)
        .where(and(eq(orderHolds.orderId, orderId), eq(orderHolds.holderKey, holderKey), isNull(orderHolds.releasedAt)))
        .limit(1);
      if (existing) {
        const [updated] = await tx
          .update(orderHolds)
          .set({ reason: text, updatedAt: new Date() })
          .where(eq(orderHolds.id, existing.id))
          .returning();
        return updated!;
      }

      const wasFree = (await this.liveHolds(tx, [orderId])).length === 0;
      const [hold] = await tx
        .insert(orderHolds)
        .values({ companyId, orderId, holderKey, reason: text, placedBy: opts.userId ?? null })
        .returning();
      if (wasFree) {
        await emitDomainEvent(tx, {
          companyId,
          eventType: 'order.held',
          aggregateType: 'order',
          aggregateId: orderId,
          payload: { orderId, holderKey, reason: text },
        });
      }
      return hold!;
    };
    return opts.tx ? run(opts.tx) : this.db.transaction(run);
  }

  /**
   * Releases the holder's hold. When it was the last one, emits order.released.
   * Returns whether the order is now free. Releasing a hold that is not there is
   * not an error: the caller wanted it gone, and it is.
   */
  async release(
    orderId: string,
    companyId: string,
    holderKey: string,
    opts: { tx?: DbTx; userId?: string | null } = {},
  ): Promise<{ released: boolean; free: boolean }> {
    const run = async (tx: DbTx) => {
      const rows = await tx
        .update(orderHolds)
        .set({ releasedAt: new Date(), releasedBy: opts.userId ?? null, updatedAt: new Date() })
        .where(
          and(
            eq(orderHolds.orderId, orderId),
            eq(orderHolds.companyId, companyId),
            eq(orderHolds.holderKey, holderKey),
            isNull(orderHolds.releasedAt),
          ),
        )
        .returning({ id: orderHolds.id });
      const free = (await this.liveHolds(tx, [orderId])).length === 0;
      if (rows.length > 0 && free) {
        await emitDomainEvent(tx, {
          companyId,
          eventType: 'order.released',
          aggregateType: 'order',
          aggregateId: orderId,
          payload: { orderId, holderKey },
        });
      }
      return { released: rows.length > 0, free };
    };
    return opts.tx ? run(opts.tx) : this.db.transaction(run);
  }

  /** The order's holds that have not been released, oldest first. */
  async liveFor(orderId: string): Promise<OrderHold[]> {
    return this.liveHolds(this.db, [orderId]);
  }

  /** Throws OrderHeldError if the order has a hold that is not released. */
  async assertFree(orderId: string): Promise<void> {
    const holds = await this.liveFor(orderId);
    if (holds.length > 0) throw new OrderHeldError(holds.map((h) => h.reason));
  }

  async isHeld(orderId: string): Promise<boolean> {
    return (await this.liveFor(orderId)).length > 0;
  }

  /** Live holds for many orders at once, keyed by order id. For lists. */
  async liveByOrder(orderIds: string[]): Promise<Map<string, OrderHold[]>> {
    const map = new Map<string, OrderHold[]>();
    for (let i = 0; i < orderIds.length; i += 1000) {
      for (const hold of await this.liveHolds(this.db, orderIds.slice(i, i + 1000))) {
        map.set(hold.orderId, [...(map.get(hold.orderId) ?? []), hold]);
      }
    }
    return map;
  }

  /** Every hold the order has had, newest first: its sign-off history. */
  async historyFor(orderId: string, companyId: string): Promise<OrderHold[]> {
    const rows = await this.db
      .select()
      .from(orderHolds)
      .where(and(eq(orderHolds.orderId, orderId), eq(orderHolds.companyId, companyId)))
      .orderBy(asc(orderHolds.createdAt));
    return rows.reverse();
  }

  private async liveHolds(tx: DbOrTx, orderIds: string[]): Promise<OrderHold[]> {
    if (orderIds.length === 0) return [];
    return tx
      .select()
      .from(orderHolds)
      .where(and(inArray(orderHolds.orderId, orderIds), isNull(orderHolds.releasedAt), isNull(orderHolds.deletedAt)))
      .orderBy(asc(orderHolds.createdAt));
  }
}

/** "On hold: <reason>" for each live hold, in words for the dispatcher. */
export function holdReasons(holds: Array<Pick<OrderHold, 'reason'>>): string[] {
  return holds.map((h) => `On hold: ${h.reason}`);
}
