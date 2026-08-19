/**
 * GoodsInService (P8, spec §A7) — book deliveries into the per-site ledger.
 *
 * A receipt accepts received quantities in the supplier's purchase unit,
 * converts to stock units via `purchase_to_stock_factor`, writes a GRN movement
 * at the receiving site, optionally matches a reorder proposal (partial / over /
 * under variance), and posts a GRN to Xero. Idempotent on `idempotencyKey` — a
 * re-confirm returns the existing receipt and re-applies nothing.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  goodsInReceiptLines,
  goodsInReceipts,
  products,
  reorderProposals,
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
}

export interface GoodsInInput {
  siteId: string;
  supplierId?: string | null;
  reorderProposalId?: string | null;
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
    const prepared = [];
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
      });
    }
    totalStockValue = round2(totalStockValue);
    const deliveryCharge = round2(input.deliveryCharge ?? 0);

    // Create the receipt + lines.
    const [receipt] = await this.db
      .insert(goodsInReceipts)
      .values({
        companyId,
        siteId: input.siteId,
        supplierId: input.supplierId ?? proposal?.supplierId ?? null,
        reorderProposalId: input.reorderProposalId ?? null,
        reference: input.reference ?? null,
        idempotencyKey: input.idempotencyKey,
        deliveryCharge: String(deliveryCharge),
        totalStockValue: String(totalStockValue),
        variance: receiptVariance,
        photoRefs: (input.photoRefs as Record<string, unknown> | undefined) ?? null,
        glReference: glIdempotencyKey('GRN', input.idempotencyKey),
      })
      .returning();

    for (const p of prepared) {
      await this.db.insert(goodsInReceiptLines).values({
        receiptId: receipt!.id,
        productId: p.productId,
        qtyPurchase: String(p.qtyPurchase),
        qtyStock: String(p.qtyStock),
        unitCost: String(p.unitCost),
        lineValue: String(p.lineValue),
        expectedQtyPurchase: p.expectedQtyPurchase != null ? String(p.expectedQtyPurchase) : null,
        lineVariance: p.lineVariance,
      });
      // GRN movement at the receiving site (in stock_uom).
      await this.levels.applyMovement({
        productId: p.productId,
        siteId: input.siteId,
        qtyDelta: p.qtyStock,
        movementType: 'GRN',
        sourceSystem: 'goods-in',
        sourceKey: `${receipt!.id}:${p.productId}`,
        contentHash: 'grn',
        unitCost: p.unitCostPerStock,
        currencyCode,
        companyId,
      });
      // Batch-tracked items: record the lot (FEFO-decremented on consumption).
      if (p.requireBatchNumber && p.batchCode) {
        await this.batches.receive({
          productId: p.productId,
          siteId: input.siteId,
          batchCode: p.batchCode,
          qty: p.qtyStock,
          useBy: p.useBy,
          unitCost: p.unitCostPerStock,
          currencyCode,
          companyId,
        });
      }
    }

    // Post the GRN to Xero (idempotent on the receipt key), in the site's currency.
    await getStockGLService().postGoodsReceivedNote(this.db, {
      companyId,
      grnId: input.idempotencyKey,
      grnNumber: receipt!.reference ?? receipt!.id.slice(0, 8),
      poNumber: input.reorderProposalId ?? input.reference ?? 'AUTO',
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
          sourceRef: receipt!.id,
          companyId,
        });
      } catch {
        // swallow — image capture must not break goods-in
      }
    }

    const lines = await this.db
      .select()
      .from(goodsInReceiptLines)
      .where(eq(goodsInReceiptLines.receiptId, receipt!.id));
    return { receipt: receipt!, lines, alreadyExisted: false };
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

    const [reversal] = await this.db
      .insert(goodsInReceipts)
      .values({
        companyId,
        siteId: original.siteId,
        supplierId: original.supplierId,
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
      .returning();

    for (const line of originalLines) {
      const qtyPurchase = -Number(line.qtyPurchase);
      const qtyStock = -Number(line.qtyStock);
      const unitCost = Number(line.unitCost);
      const factor = qtyStock === 0 ? 1 : Number(line.qtyStock) / Number(line.qtyPurchase || 1);

      await this.db.insert(goodsInReceiptLines).values({
        receiptId: reversal!.id,
        productId: line.productId,
        qtyPurchase: String(qtyPurchase),
        qtyStock: String(qtyStock),
        unitCost: String(unitCost),
        lineValue: String(round2(-Number(line.lineValue))),
        lineVariance: 'NONE',
      });

      await this.levels.applyMovement({
        productId: line.productId,
        siteId: original.siteId,
        qtyDelta: qtyStock,
        movementType: 'GRN',
        sourceSystem: 'goods-in',
        sourceKey: `${reversal!.id}:${line.productId}`,
        contentHash: 'grn-reversal',
        unitCost: round4(unitCost / (factor || 1)),
        currencyCode,
        companyId,
      });
    }

    // Mark the original as reversed. Its own figures are untouched — this is a
    // pointer, not an edit to what was booked.
    await this.db
      .update(goodsInReceipts)
      .set({
        reversedByReceiptId: reversal!.id,
        reversedAt: new Date(),
        reversedByUserId: input.userId ?? null,
        reversalReason: input.reason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(goodsInReceipts.id, original.id));

    // One mirroring GL posting, idempotent on the reversal's own key.
    await getStockGLService().postGoodsReceivedNote(this.db, {
      companyId,
      grnId: reversalKey,
      grnNumber: reversal!.reference ?? reversal!.id.slice(0, 8),
      poNumber: original.reference ?? 'REVERSAL',
      bookedInDate: new Date(),
      stockValue: totalStockValue,
      deliveryCharge,
      isService: false,
      currencyCode,
    });

    const lines = await this.db
      .select()
      .from(goodsInReceiptLines)
      .where(eq(goodsInReceiptLines.receiptId, reversal!.id));
    return { reversal: reversal!, lines, alreadyExisted: false };
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
