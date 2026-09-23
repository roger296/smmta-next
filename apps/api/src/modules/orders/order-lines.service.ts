/**
 * Editing the lines of an open order: change a line's quantity or price, add
 * a line, remove one.
 *
 * Every edit happens in one transaction and leaves the order consistent:
 *   - the order's totals are recomputed the way create() computes them;
 *   - stock the order holds beyond what its lines now need is released, unit
 *     by unit, unscanned units first, so a serial the dispatcher has already
 *     scanned into the box is kept;
 *   - an order that had been through allocation has its status recomputed
 *     (ALLOCATED, PARTIALLY_ALLOCATED or BACK_ORDERED); one that has not is
 *     left as it was, since nothing has tried to allocate it yet;
 *   - order.lines_changed is emitted, which refreshes the pick note (and lets
 *     an extension react, e.g. by withdrawing a sign-off).
 *
 * Not editable: a shipped or cancelled order, one that already has an invoice
 * (its figures are on paper), or one paid for through a storefront (the
 * customer has been charged the old total).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { customerOrders, invoices, orderLines, products, stockItems } from '../../db/schema/index.js';
import { emitDomainEvent, type DbTx } from '../../shared/events/emit.js';
import { roundMoney } from '../../shared/utils/currency.js';

const CLOSED_STATUSES = ['SHIPPED', 'PARTIALLY_SHIPPED', 'COMPLETED', 'CANCELLED', 'INVOICED'];
const ALLOCATION_STATUSES = ['ALLOCATED', 'PARTIALLY_ALLOCATED', 'BACK_ORDERED'];

export class OrderLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderLineError';
  }
}

export class OrderLineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderLineNotFoundError';
  }
}

export interface NewLineInput {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  taxRate?: number;
}

export interface LineChangeInput {
  quantity?: number;
  pricePerUnit?: number;
}

export interface LineEditResult {
  orderId: string;
  status: string;
  orderTotal: string;
  taxTotal: string;
  grandTotal: string;
  /** Units put back into stock because the order no longer needs them. */
  released: number;
}

type LineRow = { productId: string; quantity: number; numberShipped: number | null; fulfilmentSource: string };

const money = (n: number) => roundMoney(n).toFixed(2);

export class OrderLinesService {
  private readonly db = getDb();

  constructor(private readonly deps: { now?: () => Date } = {}) {}

  async addLine(orderId: string, companyId: string, input: NewLineInput): Promise<LineEditResult> {
    if (input.quantity <= 0) throw new OrderLineError('Quantity must be more than zero.');
    if (input.pricePerUnit < 0) throw new OrderLineError('Price cannot be negative.');
    return this.edit(orderId, companyId, async (tx, now) => {
      const [product] = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.id, input.productId), eq(products.companyId, companyId), isNull(products.deletedAt)))
        .limit(1);
      if (!product) throw new OrderLineNotFoundError('Product not found.');
      const taxRate = input.taxRate ?? 20;
      const lineTotal = roundMoney(input.quantity * input.pricePerUnit);
      await tx.insert(orderLines).values({
        orderId,
        productId: input.productId,
        quantity: input.quantity,
        pricePerUnit: money(input.pricePerUnit),
        taxName: 'VAT ' + taxRate + '%',
        taxRate,
        taxValue: money(lineTotal * (taxRate / 100)),
        lineTotal: money(lineTotal),
        numberShipped: 0,
        remainingQuantity: Math.ceil(input.quantity),
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  async updateLine(orderId: string, companyId: string, lineId: string, input: LineChangeInput): Promise<LineEditResult> {
    if (input.quantity === undefined && input.pricePerUnit === undefined) throw new OrderLineError('Nothing to change.');
    if (input.quantity !== undefined && input.quantity <= 0) {
      throw new OrderLineError('Quantity must be more than zero. Remove the line instead.');
    }
    if (input.pricePerUnit !== undefined && input.pricePerUnit < 0) throw new OrderLineError('Price cannot be negative.');
    return this.edit(orderId, companyId, async (tx, now) => {
      const line = await this.lineOf(tx, orderId, lineId);
      const quantity = input.quantity ?? Number(line.quantity);
      const pricePerUnit = input.pricePerUnit ?? Number(line.pricePerUnit);
      const shipped = line.numberShipped ?? 0;
      if (quantity < shipped) {
        throw new OrderLineError(shipped + ' of this line has already shipped, so the quantity cannot go below that.');
      }
      const taxRate = Number(line.taxRate ?? 0);
      const lineTotal = roundMoney(quantity * pricePerUnit);
      await tx
        .update(orderLines)
        .set({
          quantity,
          pricePerUnit: money(pricePerUnit),
          taxValue: money(lineTotal * (taxRate / 100)),
          lineTotal: money(lineTotal),
          remainingQuantity: Math.ceil(quantity - shipped),
          updatedAt: now,
        })
        .where(eq(orderLines.id, lineId));
    });
  }

  async removeLine(orderId: string, companyId: string, lineId: string): Promise<LineEditResult> {
    return this.edit(orderId, companyId, async (tx, now) => {
      const line = await this.lineOf(tx, orderId, lineId);
      if ((line.numberShipped ?? 0) > 0) throw new OrderLineError('Part of this line has already shipped, so it cannot be removed.');
      const remaining = await tx
        .select({ id: orderLines.id })
        .from(orderLines)
        .where(and(eq(orderLines.orderId, orderId), isNull(orderLines.deletedAt)));
      if (remaining.length <= 1) throw new OrderLineError('An order needs at least one line. Cancel the order instead.');
      await tx.update(orderLines).set({ deletedAt: now, updatedAt: now }).where(eq(orderLines.id, lineId));
    });
  }

  private async lineOf(tx: DbTx, orderId: string, lineId: string) {
    const [line] = await tx
      .select()
      .from(orderLines)
      .where(and(eq(orderLines.id, lineId), eq(orderLines.orderId, orderId), isNull(orderLines.deletedAt)))
      .for('update');
    if (!line) throw new OrderLineNotFoundError('Line not found on this order.');
    return line;
  }

  /** Locks the order, checks it may be edited, applies the change, then puts everything else right. */
  private async edit(
    orderId: string,
    companyId: string,
    change: (tx: DbTx, now: Date) => Promise<void>,
  ): Promise<LineEditResult> {
    const now = this.deps.now?.() ?? new Date();
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)))
        .for('update');
      if (!order) throw new OrderLineNotFoundError('Order not found.');
      if (CLOSED_STATUSES.includes(order.status)) {
        throw new OrderLineError('This order is ' + order.status.toLowerCase().replace(/_/g, ' ') + ', so its lines cannot be changed.');
      }
      const meta = order.integrationMetadata as { mollie?: unknown } | null;
      if (meta?.mollie) {
        throw new OrderLineError('This order was paid for online, so its lines cannot be changed. Refund it and place a new order.');
      }
      const [invoice] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.orderId, orderId), isNull(invoices.deletedAt)))
        .limit(1);
      if (invoice) throw new OrderLineError('This order has been invoiced, so its lines cannot be changed.');

      await change(tx, now);

      const lines = await tx
        .select()
        .from(orderLines)
        .where(and(eq(orderLines.orderId, orderId), isNull(orderLines.deletedAt)));

      // Totals, as create() computes them.
      const orderTotal = lines.reduce((s, l) => s + Number(l.lineTotal), 0);
      const taxTotal = lines.reduce((s, l) => s + Number(l.taxValue ?? 0), 0);
      const grandTotal = orderTotal + taxTotal + Number(order.deliveryCharge ?? 0);

      // Stock beyond what the lines now need goes back, unscanned units first.
      const released = await this.releaseExcess(tx, companyId, orderId, lines, now);

      // Status, for an order that has been through allocation.
      let status = order.status;
      if (ALLOCATION_STATUSES.includes(order.status)) {
        const held = await this.heldByProduct(tx, companyId, orderId);
        let short = false;
        let any = false;
        for (const [productId, needed] of this.neededByProduct(lines)) {
          const have = held.get(productId) ?? 0;
          if (have > 0) any = true;
          if (have < needed) short = true;
        }
        status = !short ? 'ALLOCATED' : any ? 'PARTIALLY_ALLOCATED' : 'BACK_ORDERED';
      }

      await tx
        .update(customerOrders)
        .set({
          orderTotal: money(orderTotal),
          taxTotal: money(taxTotal),
          grandTotal: money(grandTotal),
          status: status as typeof order.status,
          updatedAt: now,
        })
        .where(eq(customerOrders.id, orderId));

      await emitDomainEvent(tx, {
        companyId,
        eventType: 'order.lines_changed',
        aggregateType: 'order',
        aggregateId: orderId,
        payload: { orderId, orderNumber: order.orderNumber },
      });
      if (status === 'ALLOCATED' && order.status !== 'ALLOCATED') {
        await emitDomainEvent(tx, {
          companyId,
          eventType: 'order.allocated',
          aggregateType: 'order',
          aggregateId: orderId,
          payload: { orderId, orderNumber: order.orderNumber, source: order.sourceChannel },
        });
      }

      return { orderId, status, orderTotal: money(orderTotal), taxTotal: money(taxTotal), grandTotal: money(grandTotal), released };
    });
  }

  private neededByProduct(lines: LineRow[]) {
    const needed = new Map<string, number>();
    for (const l of lines) {
      if (l.fulfilmentSource === 'SUPPLIER') continue;
      needed.set(l.productId, (needed.get(l.productId) ?? 0) + Math.ceil(l.quantity - (l.numberShipped ?? 0)));
    }
    return needed;
  }

  private async heldByProduct(tx: DbTx, companyId: string, orderId: string) {
    const rows = await tx
      .select({ productId: stockItems.productId })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          eq(stockItems.salesOrderId, orderId),
          eq(stockItems.status, 'ALLOCATED'),
          isNull(stockItems.deletedAt),
        ),
      );
    const held = new Map<string, number>();
    for (const r of rows) held.set(r.productId, (held.get(r.productId) ?? 0) + 1);
    return held;
  }

  private async releaseExcess(tx: DbTx, companyId: string, orderId: string, lines: LineRow[], now: Date): Promise<number> {
    const needed = this.neededByProduct(lines);
    const held = await tx
      .select({ id: stockItems.id, productId: stockItems.productId, scannedAt: stockItems.scannedAt, createdAt: stockItems.createdAt })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          eq(stockItems.salesOrderId, orderId),
          eq(stockItems.status, 'ALLOCATED'),
          isNull(stockItems.deletedAt),
        ),
      )
      .for('update');

    const toRelease: string[] = [];
    const byProduct = new Map<string, typeof held>();
    for (const u of held) byProduct.set(u.productId, [...(byProduct.get(u.productId) ?? []), u]);
    for (const [productId, units] of byProduct) {
      const keep = needed.get(productId) ?? 0;
      if (units.length <= keep) continue;
      // Unscanned units go first, newest first; a scanned unit is in the box.
      const order = (u: (typeof held)[number]) => (u.scannedAt ? 1 : 0) * 1e15 - u.createdAt.getTime();
      const sorted = [...units].sort((a, b) => order(a) - order(b));
      toRelease.push(...sorted.slice(0, units.length - keep).map((u) => u.id));
    }
    if (toRelease.length === 0) return 0;
    await tx
      .update(stockItems)
      .set({ status: 'IN_STOCK', salesOrderId: null, scannedAt: null, scannedBy: null, updatedAt: now })
      .where(inArray(stockItems.id, toRelease));
    return toRelease.length;
  }
}
