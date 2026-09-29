/**
 * GoodsInService (P8, spec §A7) — book deliveries into the per-site ledger.
 *
 * A receipt accepts received quantities in the supplier's purchase unit,
 * converts to stock units via `purchase_to_stock_factor`, writes a GRN movement
 * at the receiving site, optionally matches a reorder proposal (partial / over /
 * under variance), and posts a GRN to Xero. Idempotent on `idempotencyKey` — a
 * re-confirm returns the existing receipt and re-applies nothing.
 *
 * Against a purchase order (Sept 2026): a receipt books what ACTUALLY arrived
 * against the order's lines — some lines, part of a line, or more than was
 * ordered — and whatever has not arrived stays outstanding for a later
 * receipt. More than was ordered (or an item not on the order) is refused
 * unless the booking says `acceptOverDelivery`: an over-delivery is sometimes
 * right and sometimes a mis-pick, and the person holding the delivery note is
 * the one who knows which. The order's lines are locked for the length of the
 * booking, so two iPads booking the same order cannot both take the last 5.
 *
 * The receipt, its lines, their stock movements and their batches are written
 * in ONE transaction: a failure part-way used to leave stock moved with no
 * receipt to explain it, or a receipt whose later lines never reached the
 * ledger. The Xero posting and the photo capture run after the commit — both
 * are idempotent and retryable, and neither should hold stock rows locked
 * while it talks to the outside world.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  goodsInReceiptLines,
  goodsInReceipts,
  products,
  purchaseOrderLines,
  purchaseOrders,
  reorderProposals,
  sites,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { glIdempotencyKey } from '../../shared/utils/idempotency.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { getStockGLService } from '../../integrations/gl-provider.js';
import { getSiteCurrency } from '../sites/site-currency.js';
import { BatchService } from '../stock/batch.service.js';
import { ImageCaptureService } from '../images/image-capture.service.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
/** Quantities are numeric(18,3) on the receipt and double precision on the
 *  order: anything under half a thousandth is rounding, not a difference. */
const EPSILON = 0.0005;

type PoLine = typeof purchaseOrderLines.$inferSelect;
type PoDeliveryStatus = 'PENDING' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED';

/** A line's delivery status from what it has had against what was ordered. */
export function lineDeliveryStatus(quantity: number, booked: number): PoDeliveryStatus {
  if (booked + EPSILON >= quantity) return 'FULLY_RECEIVED';
  return booked > EPSILON ? 'PARTIALLY_RECEIVED' : 'PENDING';
}

/** The order's status from its lines': received only when every line is. */
export function orderDeliveryStatus(lines: Array<{ quantity: number; qtyBookedIn: number | null }>): PoDeliveryStatus {
  if (lines.length > 0 && lines.every((l) => (l.qtyBookedIn ?? 0) + EPSILON >= l.quantity)) return 'FULLY_RECEIVED';
  return lines.some((l) => (l.qtyBookedIn ?? 0) > EPSILON) ? 'PARTIALLY_RECEIVED' : 'PENDING';
}

export interface GoodsInLineInput {
  productId: string;
  /** Received quantity in the supplier's purchase unit. */
  qtyPurchase: number;
  /** Cost per purchase unit. */
  unitCost?: number;
  /** Batch/lot code — required when the product is batch-tracked (P21). */
  batchCode?: string;
  /** Use-by (YYYY-MM-DD) for a perishable batch. */
  useBy?: string | null;
  /** The order line this quantity counts towards. Omitted for an item that
   *  arrived but is not on the order. */
  purchaseOrderLineId?: string | null;
}

export interface GoodsInInput {
  siteId: string;
  supplierId?: string | null;
  reorderProposalId?: string | null;
  /** The order this delivery is booked against. */
  purchaseOrderId?: string | null;
  /** The supplier's delivery-note number. */
  deliveryNoteNumber?: string | null;
  /** Book quantities beyond what is outstanding on the order (and items not
   *  on it). Without this such a booking is refused with the list. */
  acceptOverDelivery?: boolean;
  reference?: string;
  idempotencyKey: string;
  deliveryCharge?: number;
  photoRefs?: unknown;
  lines: GoodsInLineInput[];
  companyId?: string;
}

export type GoodsInReceipt = typeof goodsInReceipts.$inferSelect;
export type GoodsInReceiptLine = typeof goodsInReceiptLines.$inferSelect;

export interface GoodsInResult {
  receipt: GoodsInReceipt;
  lines: GoodsInReceiptLine[];
  alreadyExisted: boolean;
}

/** A booking against an order that cannot be made as sent — no such order, a
 *  closed one, another venue's, or a line that is not on it. */
export class GoodsInPurchaseOrderError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'GoodsInPurchaseOrderError';
  }
}

export interface OverDeliveredLine {
  purchaseOrderLineId: string | null;
  productId: string;
  productName: string | null;
  /** 0 for an item that is not on the order at all. */
  ordered: number;
  alreadyReceived: number;
  receivingNow: number;
  over: number;
}

/** More arrived than is outstanding, and the booking did not accept it. */
export class OverDeliveryError extends Error {
  constructor(readonly lines: OverDeliveredLine[]) {
    super(
      `More than was ordered: ${lines
        .map((l) =>
          l.ordered === 0
            ? `${l.productName ?? 'an item'} is not on the order`
            : `${l.productName ?? 'an item'} — ordered ${l.ordered}, already received ${l.alreadyReceived}, booking ${l.receivingNow}`,
        )
        .join('; ')}. Confirm the over-delivery to book it in.`,
    );
    this.name = 'OverDeliveryError';
  }
}

/** A reversal that cannot be performed for a reason the caller should see. */
export class GoodsInReversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoodsInReversalError';
  }
}

export class GoodsInService {
  private db = getDb();
  private levels = new StockLevelService();
  private batches = new BatchService();

  async receive(input: GoodsInInput): Promise<GoodsInResult> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    const currencyCode = await getSiteCurrency(input.siteId, companyId);

    // Idempotency — a receipt with this key already booked in.
    const existing = await this.db.query.goodsInReceipts.findFirst({
      where: eq(goodsInReceipts.idempotencyKey, input.idempotencyKey),
    });
    if (existing) {
      const lines = await this.db
        .select()
        .from(goodsInReceiptLines)
        .where(eq(goodsInReceiptLines.receiptId, existing.id));
      return { receipt: existing, lines, alreadyExisted: true };
    }

    const proposal = input.reorderProposalId
      ? await this.db.query.reorderProposals.findFirst({
          where: eq(reorderProposals.id, input.reorderProposalId),
        })
      : null;

    // Resolve per-line conversion + variance.
    const prepared: Array<{
      productId: string;
      qtyPurchase: number;
      qtyStock: number;
      unitCost: number;
      unitCostPerStock: number;
      lineValue: number;
      expectedQtyPurchase: number | null;
      lineVariance: 'NONE' | 'UNDER' | 'OVER';
      requireBatchNumber: boolean;
      batchCode: string | null;
      useBy: string | null;
      purchaseOrderLineId: string | null;
      productName: string | null;
    }> = [];
    let totalStockValue = 0;
    let receiptVariance: 'NONE' | 'UNDER' | 'OVER' = 'NONE';
    for (const line of input.lines) {
      const product = await this.db.query.products.findFirst({
        where: eq(products.id, line.productId),
      });
      const factor = Number(product?.purchaseToStockFactor ?? 1) || 1;
      const qtyStock = round2(line.qtyPurchase * factor);
      const unitCost = line.unitCost ?? Number(product?.expectedNextCost ?? 0);
      const lineValue = round2(line.qtyPurchase * unitCost);
      totalStockValue += lineValue;

      let expectedQtyPurchase: number | null = null;
      let lineVariance: 'NONE' | 'UNDER' | 'OVER' = 'NONE';
      if (proposal && proposal.productId === line.productId && proposal.suggestedQtyPurchase != null) {
        expectedQtyPurchase = Number(proposal.suggestedQtyPurchase);
        if (line.qtyPurchase < expectedQtyPurchase) lineVariance = 'UNDER';
        else if (line.qtyPurchase > expectedQtyPurchase) lineVariance = 'OVER';
        receiptVariance = lineVariance;
      }

      prepared.push({
        productId: line.productId,
        qtyPurchase: line.qtyPurchase,
        qtyStock,
        unitCost,
        unitCostPerStock: round4(unitCost / factor),
        lineValue,
        expectedQtyPurchase,
        lineVariance,
        requireBatchNumber: !!product?.requireBatchNumber,
        batchCode: line.batchCode ?? null,
        useBy: line.useBy ?? null,
        purchaseOrderLineId: line.purchaseOrderLineId ?? null,
        productName: product?.name ?? null,
      });
    }
    totalStockValue = round2(totalStockValue);
    const deliveryCharge = round2(input.deliveryCharge ?? 0);

    // Receipt, lines, movements and batches: all or nothing.
    const receipt = await this.db.transaction(async (tx) => {
      // ── Against an order: lock it and its lines for the whole booking ──
      let po: typeof purchaseOrders.$inferSelect | null = null;
      const poLines = new Map<string, PoLine>();
      if (input.purchaseOrderId) {
        [po] = await tx
          .select()
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.id, input.purchaseOrderId), eq(purchaseOrders.companyId, companyId)))
          .for('update');
        if (!po || po.deletedAt) throw new GoodsInPurchaseOrderError('That purchase order does not exist.', 404);
        if (po.deliveryStatus === 'CANCELLED') {
          throw new GoodsInPurchaseOrderError(
            `${po.poNumber} has been closed, so nothing more can be booked in against it.`,
            409,
          );
        }
        if (po.siteId && po.siteId !== input.siteId) {
          const [forSite] = await tx.select({ name: sites.name }).from(sites).where(eq(sites.id, po.siteId));
          throw new GoodsInPurchaseOrderError(
            `${po.poNumber} is for ${forSite?.name ?? 'another venue'}, not the venue this delivery is being booked into.`,
            409,
          );
        }
        for (const l of await tx
          .select()
          .from(purchaseOrderLines)
          .where(and(eq(purchaseOrderLines.purchaseOrderId, po.id), isNull(purchaseOrderLines.deletedAt)))
          .for('update')) {
          poLines.set(l.id, l);
        }
      }
      for (const p of prepared) {
        if (!p.purchaseOrderLineId) continue;
        const poLine = poLines.get(p.purchaseOrderLineId);
        if (!po) {
          throw new GoodsInPurchaseOrderError('A line names an order line, but the booking names no order.');
        }
        if (!poLine) throw new GoodsInPurchaseOrderError(`A line is not on ${po.poNumber}.`);
        if (poLine.productId !== p.productId) {
          throw new GoodsInPurchaseOrderError(`A line on ${po.poNumber} is for a different product.`);
        }
      }

      const [created] = await tx
        .insert(goodsInReceipts)
        .values({
          companyId,
          siteId: input.siteId,
          supplierId: input.supplierId ?? po?.supplierId ?? proposal?.supplierId ?? null,
          reorderProposalId: input.reorderProposalId ?? null,
          purchaseOrderId: po?.id ?? null,
          deliveryNoteNumber: input.deliveryNoteNumber?.trim() || null,
          reference: input.reference ?? null,
          idempotencyKey: input.idempotencyKey,
          deliveryCharge: String(deliveryCharge),
          totalStockValue: String(totalStockValue),
          variance: receiptVariance,
          photoRefs: (input.photoRefs as Record<string, unknown> | undefined) ?? null,
          glReference: glIdempotencyKey('GRN', input.idempotencyKey),
        })
        // Two devices replaying the same queued booking at once: the second
        // waits on the unique key, then finds the first's receipt below.
        .onConflictDoNothing({ target: goodsInReceipts.idempotencyKey })
        .returning();
      if (!created) return null;

      // ── Against an order: what is outstanding, and is this more? ──
      // After the receipt insert on purpose: a replay racing its original
      // must find the original's receipt (above), not be refused as "over"
      // by the quantity the original just booked.
      if (po) {
        const receiving = new Map<string, number>();
        for (const p of prepared) {
          if (p.purchaseOrderLineId) {
            receiving.set(p.purchaseOrderLineId, round3((receiving.get(p.purchaseOrderLineId) ?? 0) + p.qtyPurchase));
          }
        }
        const over: OverDeliveredLine[] = [];
        for (const [lineId, qty] of receiving) {
          const l = poLines.get(lineId)!;
          const already = l.qtyBookedIn ?? 0;
          const outstanding = Math.max(0, round3(l.quantity - already));
          if (qty > outstanding + EPSILON) {
            over.push({
              purchaseOrderLineId: lineId,
              productId: l.productId,
              productName: prepared.find((p) => p.purchaseOrderLineId === lineId)?.productName ?? null,
              ordered: l.quantity,
              alreadyReceived: already,
              receivingNow: qty,
              over: round3(qty - outstanding),
            });
          }
        }
        for (const p of prepared.filter((x) => !x.purchaseOrderLineId)) {
          over.push({
            purchaseOrderLineId: null,
            productId: p.productId,
            productName: p.productName,
            ordered: 0,
            alreadyReceived: 0,
            receivingNow: p.qtyPurchase,
            over: p.qtyPurchase,
          });
        }
        if (over.length > 0 && !input.acceptOverDelivery) throw new OverDeliveryError(over);

        // Variance against what was outstanding, not against the original
        // order: the third delivery of a back-order is measured against
        // what was still to come.
        for (const p of prepared) {
          if (!p.purchaseOrderLineId) {
            p.lineVariance = 'OVER';
            continue;
          }
          const l = poLines.get(p.purchaseOrderLineId)!;
          const outstanding = Math.max(0, round3(l.quantity - (l.qtyBookedIn ?? 0)));
          const qty = receiving.get(p.purchaseOrderLineId)!;
          p.expectedQtyPurchase = outstanding;
          p.lineVariance = qty > outstanding + EPSILON ? 'OVER' : qty + EPSILON < outstanding ? 'UNDER' : 'NONE';
        }
        const stillOutstanding = [...poLines.values()].some(
          (l) => !receiving.has(l.id) && l.quantity - (l.qtyBookedIn ?? 0) > EPSILON,
        );
        const variance = prepared.some((p) => p.lineVariance === 'OVER')
          ? 'OVER'
          : prepared.some((p) => p.lineVariance === 'UNDER') || stillOutstanding
            ? 'UNDER'
            : 'NONE';
        await tx.update(goodsInReceipts).set({ variance }).where(eq(goodsInReceipts.id, created.id));
        created.variance = variance;

        // What the order has now had, line by line, then the order itself.
        for (const [lineId, qty] of receiving) {
          const l = poLines.get(lineId)!;
          const booked = round3((l.qtyBookedIn ?? 0) + qty);
          l.qtyBookedIn = booked;
          await tx
            .update(purchaseOrderLines)
            .set({ qtyBookedIn: booked, deliveryStatus: lineDeliveryStatus(l.quantity, booked), updatedAt: new Date() })
            .where(eq(purchaseOrderLines.id, lineId));
        }
        await tx
          .update(purchaseOrders)
          .set({ deliveryStatus: orderDeliveryStatus([...poLines.values()]), updatedAt: new Date() })
          .where(eq(purchaseOrders.id, po.id));
      }

      for (const p of prepared) {
        const recordsLot = p.requireBatchNumber && !!p.batchCode;
        const [line] = await tx
          .insert(goodsInReceiptLines)
          .values({
            receiptId: created.id,
            productId: p.productId,
            qtyPurchase: String(p.qtyPurchase),
            qtyStock: String(p.qtyStock),
            unitCost: String(p.unitCost),
            lineValue: String(p.lineValue),
            expectedQtyPurchase: p.expectedQtyPurchase != null ? String(p.expectedQtyPurchase) : null,
            lineVariance: p.lineVariance,
            batchCode: recordsLot ? p.batchCode : null,
            useBy: recordsLot ? p.useBy : null,
            purchaseOrderLineId: p.purchaseOrderLineId,
          })
          .returning({ id: goodsInReceiptLines.id });
        // GRN movement at the receiving site (in stock_uom). Keyed on the LINE,
        // not the product: two lines of one product (two lots, or two pack
        // sizes of one item) are two deliveries, and keying on the product made
        // the ledger drop the second as a duplicate.
        await this.levels.applyMovementInTx(tx, {
          productId: p.productId,
          siteId: input.siteId,
          qtyDelta: p.qtyStock,
          movementType: 'GRN',
          sourceSystem: 'goods-in',
          sourceKey: `${created.id}:${line!.id}`,
          contentHash: 'grn',
          unitCost: p.unitCostPerStock,
          currencyCode,
          companyId,
        });
        // Batch-tracked items: record the lot (FEFO-decremented on consumption).
        if (recordsLot) {
          await this.batches.receive(
            {
              productId: p.productId,
              siteId: input.siteId,
              batchCode: p.batchCode!,
              qty: p.qtyStock,
              useBy: p.useBy,
              unitCost: p.unitCostPerStock,
              currencyCode,
              companyId,
            },
            tx,
          );
        }
      }
      return created;
    });

    if (!receipt) {
      const winner = await this.db.query.goodsInReceipts.findFirst({
        where: eq(goodsInReceipts.idempotencyKey, input.idempotencyKey),
      });
      const lines = await this.db
        .select()
        .from(goodsInReceiptLines)
        .where(eq(goodsInReceiptLines.receiptId, winner!.id));
      return { receipt: winner!, lines, alreadyExisted: true };
    }

    // Post the GRN to Xero (idempotent on the receipt key), in the site's currency.
    await getStockGLService().postGoodsReceivedNote(this.db, {
      companyId,
      grnId: input.idempotencyKey,
      grnNumber: receipt.deliveryNoteNumber ?? receipt.reference ?? receipt.id.slice(0, 8),
      poNumber: (await this.poNumber(receipt.purchaseOrderId)) ?? input.reorderProposalId ?? input.reference ?? 'AUTO',
      bookedInDate: new Date(),
      stockValue: totalStockValue,
      deliveryCharge,
      isService: false,
      currencyCode,
    });

    // Capture any photos for the AI groundwork set (spec §A10) — best-effort,
    // never blocks the book-in.
    if (input.photoRefs) {
      try {
        await new ImageCaptureService().recordPhotoRefs({
          photoRefs: input.photoRefs,
          siteId: input.siteId,
          source: 'GOODS_IN',
          sourceRef: receipt.id,
          companyId,
        });
      } catch {
        // swallow — image capture must not break goods-in
      }
    }

    const lines = await this.db
      .select()
      .from(goodsInReceiptLines)
      .where(eq(goodsInReceiptLines.receiptId, receipt.id));
    return { receipt, lines, alreadyExisted: false };
  }

  /**
   * Reverse a booked receipt (Aug-2026 feedback set, defect E-3).
   *
   * "Accidental booking logged 100kg to Birmingham; requested an undo timer or
   * role-based permission locks."
   *
   * A **reversing receipt** — a new row with mirrored negative stock movements
   * and its own GL posting. The original is never mutated or deleted (locked
   * decision 6): the ledger is an audit trail, and a correction that edits
   * history is a correction nobody can later explain.
   *
   * Idempotent. The reversal's idempotency key is derived from the original
   * receipt id, so a double-tapped Undo — or a replay off the offline queue —
   * produces exactly one reversal. Re-calling returns the existing one.
   */
  async reverse(input: {
    receiptId: string;
    reason?: string | null;
    userId?: string | null;
    companyId?: string;
  }): Promise<{ reversal: GoodsInReceipt; lines: GoodsInReceiptLine[]; alreadyExisted: boolean } | null> {
    const companyId = input.companyId ?? getSingletonCompanyId();

    const original = await this.db.query.goodsInReceipts.findFirst({
      where: and(eq(goodsInReceipts.id, input.receiptId), eq(goodsInReceipts.companyId, companyId)),
    });
    if (!original) return null;

    // Reversing a reversal would net back to the original booking — almost
    // certainly not what someone tapping "undo" twice means.
    if (original.reversalOfReceiptId) {
      throw new GoodsInReversalError('That receipt is itself a reversal and cannot be reversed.');
    }

    const reversalKey = `reversal:${original.id}`;

    const existing = await this.db.query.goodsInReceipts.findFirst({
      where: eq(goodsInReceipts.idempotencyKey, reversalKey),
    });
    if (existing) {
      const lines = await this.db
        .select()
        .from(goodsInReceiptLines)
        .where(eq(goodsInReceiptLines.receiptId, existing.id));
      return { reversal: existing, lines, alreadyExisted: true };
    }

    const originalLines = await this.db
      .select()
      .from(goodsInReceiptLines)
      .where(eq(goodsInReceiptLines.receiptId, original.id));

    const currencyCode = await getSiteCurrency(original.siteId, companyId);
    const totalStockValue = round2(-Number(original.totalStockValue ?? 0));
    const deliveryCharge = round2(-Number(original.deliveryCharge ?? 0));

    const reversal = await this.db.transaction(async (tx) => {
      // A receipt against an order gave that order its quantities; undoing it
      // takes them back, so what was received becomes outstanding again.
      const poLines = new Map<string, PoLine>();
      let po: typeof purchaseOrders.$inferSelect | undefined;
      if (original.purchaseOrderId) {
        [po] = await tx
          .select()
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, original.purchaseOrderId))
          .for('update');
        for (const l of await tx
          .select()
          .from(purchaseOrderLines)
          .where(and(eq(purchaseOrderLines.purchaseOrderId, original.purchaseOrderId), isNull(purchaseOrderLines.deletedAt)))
          .for('update')) {
          poLines.set(l.id, l);
        }
      }

      const [created] = await tx
        .insert(goodsInReceipts)
        .values({
          companyId,
          siteId: original.siteId,
          supplierId: original.supplierId,
          purchaseOrderId: original.purchaseOrderId,
          deliveryNoteNumber: original.deliveryNoteNumber,
          // Deliberately NOT carried over: a reversal must not re-match the
          // proposal the original satisfied.
          reorderProposalId: null,
          reference: `REVERSAL of ${original.reference ?? original.id.slice(0, 8)}`,
          idempotencyKey: reversalKey,
          deliveryCharge: String(deliveryCharge),
          totalStockValue: String(totalStockValue),
          variance: 'NONE',
          glReference: glIdempotencyKey('GRN', reversalKey),
          reversalOfReceiptId: original.id,
          reversedByUserId: input.userId ?? null,
          reversalReason: input.reason ?? null,
        })
        // A double-tapped Undo racing itself: the loser finds the winner below.
        .onConflictDoNothing({ target: goodsInReceipts.idempotencyKey })
        .returning();
      if (!created) return null;

      for (const line of originalLines) {
        const qtyPurchase = -Number(line.qtyPurchase);
        const qtyStock = -Number(line.qtyStock);
        const unitCost = Number(line.unitCost);
        const factor = qtyStock === 0 ? 1 : Number(line.qtyStock) / Number(line.qtyPurchase || 1);

        const [mirror] = await tx
          .insert(goodsInReceiptLines)
          .values({
            receiptId: created.id,
            productId: line.productId,
            qtyPurchase: String(qtyPurchase),
            qtyStock: String(qtyStock),
            unitCost: String(unitCost),
            lineValue: String(round2(-Number(line.lineValue))),
            lineVariance: 'NONE',
            batchCode: line.batchCode,
            useBy: line.useBy,
            purchaseOrderLineId: line.purchaseOrderLineId,
          })
          .returning({ id: goodsInReceiptLines.id });

        await this.levels.applyMovementInTx(tx, {
          productId: line.productId,
          siteId: original.siteId,
          qtyDelta: qtyStock,
          movementType: 'GRN',
          sourceSystem: 'goods-in',
          sourceKey: `${created.id}:${mirror!.id}`,
          contentHash: 'grn-reversal',
          unitCost: round4(unitCost / (factor || 1)),
          currencyCode,
          companyId,
        });

        // Take the quantity back off the lot it went into. Whatever of it has
        // already been used stays used (the ledger movement above still
        // reverses the full amount; the lot just cannot go below empty).
        if (line.batchCode) {
          await this.batches.reverseReceipt(
            {
              productId: line.productId,
              siteId: original.siteId,
              batchCode: line.batchCode,
              qty: Number(line.qtyStock),
              companyId,
            },
            tx,
          );
        }
      }

      // Hand the quantities back to the order's lines.
      const returned = new Map<string, number>();
      for (const line of originalLines) {
        if (line.purchaseOrderLineId) {
          returned.set(line.purchaseOrderLineId, (returned.get(line.purchaseOrderLineId) ?? 0) + Number(line.qtyPurchase));
        }
      }
      for (const [lineId, qty] of returned) {
        const l = poLines.get(lineId);
        if (!l) continue; // a line deleted from the order since: nothing to give back to
        const booked = Math.max(0, round3((l.qtyBookedIn ?? 0) - qty));
        l.qtyBookedIn = booked;
        await tx
          .update(purchaseOrderLines)
          .set({ qtyBookedIn: booked, deliveryStatus: lineDeliveryStatus(l.quantity, booked), updatedAt: new Date() })
          .where(eq(purchaseOrderLines.id, lineId));
      }
      // A closed order stays closed; any other goes back to what its lines say.
      if (po && returned.size > 0 && po.deliveryStatus !== 'CANCELLED') {
        await tx
          .update(purchaseOrders)
          .set({ deliveryStatus: orderDeliveryStatus([...poLines.values()]), updatedAt: new Date() })
          .where(eq(purchaseOrders.id, po.id));
      }

      // Mark the original as reversed. Its own figures are untouched — this is
      // a pointer, not an edit to what was booked.
      await tx
        .update(goodsInReceipts)
        .set({
          reversedByReceiptId: created.id,
          reversedAt: new Date(),
          reversedByUserId: input.userId ?? null,
          reversalReason: input.reason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(goodsInReceipts.id, original.id));
      return created;
    });

    if (!reversal) {
      const winner = await this.db.query.goodsInReceipts.findFirst({
        where: eq(goodsInReceipts.idempotencyKey, reversalKey),
      });
      const lines = await this.db
        .select()
        .from(goodsInReceiptLines)
        .where(eq(goodsInReceiptLines.receiptId, winner!.id));
      return { reversal: winner!, lines, alreadyExisted: true };
    }

    // One mirroring GL posting, idempotent on the reversal's own key.
    await getStockGLService().postGoodsReceivedNote(this.db, {
      companyId,
      grnId: reversalKey,
      grnNumber: reversal.reference ?? reversal.id.slice(0, 8),
      poNumber: (await this.poNumber(original.purchaseOrderId)) ?? original.reference ?? 'REVERSAL',
      bookedInDate: new Date(),
      stockValue: totalStockValue,
      deliveryCharge,
      isService: false,
      currencyCode,
    });

    const lines = await this.db
      .select()
      .from(goodsInReceiptLines)
      .where(eq(goodsInReceiptLines.receiptId, reversal.id));
    return { reversal, lines, alreadyExisted: false };
  }

  /** The order number for the GRN posting's reference, when there is one. */
  private async poNumber(purchaseOrderId: string | null): Promise<string | null> {
    if (!purchaseOrderId) return null;
    const [row] = await this.db
      .select({ poNumber: purchaseOrders.poNumber })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, purchaseOrderId));
    return row?.poNumber ?? null;
  }

  async get(id: string, companyId = getSingletonCompanyId()): Promise<GoodsInResult | null> {
    const receipt = await this.db.query.goodsInReceipts.findFirst({
      where: and(eq(goodsInReceipts.id, id), eq(goodsInReceipts.companyId, companyId)),
    });
    if (!receipt) return null;
    const lines = await this.db
      .select()
      .from(goodsInReceiptLines)
      .where(eq(goodsInReceiptLines.receiptId, id));
    return { receipt, lines, alreadyExisted: true };
  }

  async list(
    filter: { siteId?: string; companyId?: string } = {},
  ): Promise<GoodsInReceipt[]> {
    const companyId = filter.companyId ?? getSingletonCompanyId();
    const where = [eq(goodsInReceipts.companyId, companyId)];
    if (filter.siteId) where.push(eq(goodsInReceipts.siteId, filter.siteId));
    return this.db.query.goodsInReceipts.findMany({
      where: and(...where),
      orderBy: (r, { desc }) => [desc(r.receivedAt)],
    });
  }
}
