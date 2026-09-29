/**
 * Booking a delivery in against an order on the venue iPad (DECISIONS.md F24).
 *
 * The rules the goods-in screen follows when an order is picked, kept pure so
 * they are tested once:
 *  - every line still to come is laid out at what is still to come, and the
 *    person corrects it to what actually arrived — 0 for "didn't come", which
 *    leaves it on the order for a later delivery;
 *  - a product scanned while an order is open is matched to its order line,
 *    even one already complete (a late extra is an over-delivery on that
 *    line, not a stray);
 *  - anything more than is still to come, or not on the order at all, is an
 *    over-delivery: shown on the confirmation, and confirming it is what
 *    accepts it.
 */
import type { Product } from '@/lib/api-types';

export interface OrderLineRef {
  purchaseOrderLineId: string;
  ordered: number;
  received: number;
  /** Still to come BEFORE this delivery. */
  outstanding: number;
}

/** The part of a screen line these rules read. */
export interface BookingLine {
  product: Product;
  qtyPurchase: number;
  order?: OrderLineRef;
}

export interface OrderContext {
  id: string;
  poNumber: string;
  supplierName: string;
  lines: Array<{ id: string; product: Product; ordered: number; received: number; outstanding: number }>;
}

export interface OverDelivered {
  name: string;
  unit: string;
  /** How much more than is still to come; the whole quantity when not on the order. */
  extra: number;
  notOnOrder: boolean;
}

const EPS = 0.0005;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const unitOf = (p: Product): string => p.purchaseUom ?? 'unit';

export function refFor(line: OrderContext['lines'][number]): OrderLineRef {
  return { purchaseOrderLineId: line.id, ordered: line.ordered, received: line.received, outstanding: line.outstanding };
}

/** The order's lines still to come, each at what is still to come. */
export function linesFromOrder(order: OrderContext): Array<{ product: Product; qtyPurchase: number; order: OrderLineRef }> {
  return order.lines
    .filter((l) => l.outstanding > EPS)
    .map((l) => ({ product: l.product, qtyPurchase: l.outstanding, order: refFor(l) }));
}

/** The order line a scanned product belongs to, if it is on the order at all. */
export function orderLineFor(order: OrderContext | null, productId: string): OrderLineRef | undefined {
  const line = order?.lines.find((l) => l.product.id === productId);
  return line ? refFor(line) : undefined;
}

/** Lines that book anything — a line at 0 books nothing and stays on the order. */
export function bookableLines<T extends BookingLine>(lines: T[]): T[] {
  return lines.filter((l) => l.qtyPurchase > EPS);
}

/** Everything that is more than was ordered. Only meaningful against an order. */
export function overDeliveries(lines: BookingLine[], againstOrder: boolean): OverDelivered[] {
  if (!againstOrder) return [];
  const byOrderLine = new Map<string, { line: BookingLine; qty: number }>();
  const over: OverDelivered[] = [];
  for (const l of bookableLines(lines)) {
    if (!l.order) {
      over.push({ name: l.product.name, unit: unitOf(l.product), extra: round3(l.qtyPurchase), notOnOrder: true });
      continue;
    }
    const seen = byOrderLine.get(l.order.purchaseOrderLineId);
    byOrderLine.set(l.order.purchaseOrderLineId, { line: l, qty: round3((seen?.qty ?? 0) + l.qtyPurchase) });
  }
  for (const { line, qty } of byOrderLine.values()) {
    if (qty > line.order!.outstanding + EPS) {
      over.push({ name: line.product.name, unit: unitOf(line.product), extra: round3(qty - line.order!.outstanding), notOnOrder: false });
    }
  }
  return over;
}

/** How many of the order's lines will still have something to come after this delivery. */
export function stillToComeAfter(order: OrderContext, lines: BookingLine[]): number {
  const booking = new Map<string, number>();
  for (const l of bookableLines(lines)) {
    if (l.order) booking.set(l.order.purchaseOrderLineId, (booking.get(l.order.purchaseOrderLineId) ?? 0) + l.qtyPurchase);
  }
  return order.lines.filter((l) => l.outstanding - (booking.get(l.id) ?? 0) > EPS).length;
}

/** "Ordered 10 · 4 in already · 6 to come". */
export function describeOrderLine(ref: OrderLineRef, product: Product): string {
  const unit = unitOf(product);
  const n = (v: number) => `${round3(v)}`;
  return ref.outstanding > EPS
    ? `Ordered ${n(ref.ordered)} ${unit} · ${n(ref.received)} in already · ${n(ref.outstanding)} to come`
    : `Ordered ${n(ref.ordered)} ${unit} · all already in`;
}
