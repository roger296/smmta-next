/**
 * What there is to book in (supplier ordering, Sept 2026).
 *
 * Read side of booking deliveries against purchase orders: the orders a venue
 * is expecting, and one order laid out for booking — each line with what was
 * ordered, what has arrived so far and what is still to come, plus every
 * receipt already booked against it. The write side is `GoodsInService.receive`
 * with a `purchaseOrderId`.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  goodsInReceipts,
  products,
  purchaseOrderLines,
  purchaseOrders,
  sites,
  suppliers,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface ExpectedOrder {
  id: string;
  poNumber: string;
  supplierName: string;
  expectedDeliveryDate: string | null;
  deliveryStatus: string;
  lines: number;
  linesOutstanding: number;
  createdAt: Date;
}

export interface ReceivingLine {
  id: string;
  product: typeof products.$inferSelect;
  /** In the product's purchase unit. */
  ordered: number;
  received: number;
  /** What is still to come; 0 once the line is complete (never negative, even
   *  after an over-delivery). */
  outstanding: number;
  pricePerUnit: string;
  deliveryStatus: string;
}

export interface ReceivingView {
  id: string;
  poNumber: string;
  supplier: { id: string; name: string };
  site: { id: string; name: string } | null;
  deliveryStatus: string;
  expectedDeliveryDate: string | null;
  currencyCode: string;
  lines: ReceivingLine[];
  receipts: Array<{
    id: string;
    receivedAt: Date;
    deliveryNoteNumber: string | null;
    reference: string | null;
    totalStockValue: string;
    variance: string;
    lines: number;
    reversalOfReceiptId: string | null;
    reversedAt: Date | null;
  }>;
}

/** Orders a venue is still waiting on, soonest expected first. */
export async function openOrdersForSite(siteId: string, companyId = getSingletonCompanyId()): Promise<ExpectedOrder[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      supplierName: suppliers.name,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      deliveryStatus: purchaseOrders.deliveryStatus,
      createdAt: purchaseOrders.createdAt,
      lines: sql<number>`(SELECT count(*)::int FROM purchase_order_lines l
                          WHERE l.purchase_order_id = "purchase_orders"."id" AND l.deleted_at IS NULL)`,
      linesOutstanding: sql<number>`(SELECT count(*)::int FROM purchase_order_lines l
                          WHERE l.purchase_order_id = "purchase_orders"."id" AND l.deleted_at IS NULL
                            AND coalesce(l.qty_booked_in, 0) + 0.0005 < l.quantity)`,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(
      and(
        eq(purchaseOrders.companyId, companyId),
        eq(purchaseOrders.siteId, siteId),
        isNull(purchaseOrders.deletedAt),
        inArray(purchaseOrders.deliveryStatus, ['PENDING', 'PARTIALLY_RECEIVED']),
      ),
    )
    .orderBy(sql`${purchaseOrders.expectedDeliveryDate} ASC NULLS LAST`, asc(purchaseOrders.createdAt));
  return rows.map((r) => ({ ...r, lines: Number(r.lines), linesOutstanding: Number(r.linesOutstanding) }));
}

/** One order laid out for booking in, or null if there is no such order. */
export async function receivingView(poId: string, companyId = getSingletonCompanyId()): Promise<ReceivingView | null> {
  const db = getDb();
  const [po] = await db
    .select({ po: purchaseOrders, supplierName: suppliers.name, siteName: sites.name })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .leftJoin(sites, eq(sites.id, purchaseOrders.siteId))
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, companyId), isNull(purchaseOrders.deletedAt)));
  if (!po) return null;

  const lines = await db
    .select({ line: purchaseOrderLines, product: products })
    .from(purchaseOrderLines)
    .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
    .where(and(eq(purchaseOrderLines.purchaseOrderId, poId), isNull(purchaseOrderLines.deletedAt)))
    // Lines created together share a timestamp, so the name breaks the tie:
    // a stable order is what lets two people read the same list.
    .orderBy(asc(purchaseOrderLines.createdAt), asc(products.name), asc(purchaseOrderLines.id));

  const receipts = await db
    .select({
      id: goodsInReceipts.id,
      receivedAt: goodsInReceipts.receivedAt,
      deliveryNoteNumber: goodsInReceipts.deliveryNoteNumber,
      reference: goodsInReceipts.reference,
      totalStockValue: goodsInReceipts.totalStockValue,
      variance: goodsInReceipts.variance,
      reversalOfReceiptId: goodsInReceipts.reversalOfReceiptId,
      reversedAt: goodsInReceipts.reversedAt,
      // Table names spelled out: with no join in the outer query drizzle
      // leaves column references unqualified, and a bare "id" inside the
      // subquery would be the LINE's id.
      lines: sql<number>`(SELECT count(*)::int FROM goods_in_receipt_lines l
                          WHERE l.receipt_id = "goods_in_receipts"."id")`,
    })
    .from(goodsInReceipts)
    .where(eq(goodsInReceipts.purchaseOrderId, poId))
    .orderBy(asc(goodsInReceipts.receivedAt));

  return {
    id: po.po.id,
    poNumber: po.po.poNumber,
    supplier: { id: po.po.supplierId, name: po.supplierName },
    site: po.po.siteId ? { id: po.po.siteId, name: po.siteName ?? '' } : null,
    deliveryStatus: po.po.deliveryStatus,
    expectedDeliveryDate: po.po.expectedDeliveryDate,
    currencyCode: po.po.currencyCode,
    lines: lines.map(({ line, product }) => {
      const received = round3(line.qtyBookedIn ?? 0);
      return {
        id: line.id,
        product,
        ordered: line.quantity,
        received,
        outstanding: Math.max(0, round3(line.quantity - received)),
        pricePerUnit: line.pricePerUnit,
        deliveryStatus: line.deliveryStatus,
      };
    }),
    receipts: receipts.map((r) => ({ ...r, lines: Number(r.lines) })),
  };
}
