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

    const lines = await this.db
      .select()
      .from(goodsInReceiptLines)
      .where(eq(goodsInReceiptLines.receiptId, receipt!.id));
    return { receipt: receipt!, lines, alreadyExisted: false };
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
