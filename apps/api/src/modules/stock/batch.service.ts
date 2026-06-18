/**
 * BatchService (P21, spec §A3, §9) — batch/lot + use-by tracking with FEFO.
 *
 * Only products with `require_batch_number` carry batches. A batch is created
 * on goods-in (`receive`) and decremented first-expiry-first-out (`decrementFEFO`)
 * on consumption, so the oldest use-by leaves first. Expiry is surfaced via
 * `expired` / `expiringSoon` for the reports. The `stock_movements` ledger
 * remains the source of truth for total on-hand; batches add the lot detail.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, stockBatches } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export type StockBatch = typeof stockBatches.$inferSelect;

export interface ReceiveBatchInput {
  productId: string;
  siteId: string;
  batchCode: string;
  qty: number;
  useBy?: string | null; // YYYY-MM-DD
  unitCost?: number | null;
  currencyCode?: string;
  companyId?: string;
}

export interface FefoAllocation {
  batchId: string;
  batchCode: string;
  useBy: string | null;
  qty: number;
}

export interface EnrichedBatch {
  batchId: string;
  batchCode: string;
  productId: string;
  productName: string;
  siteId: string;
  useBy: string | null;
  qtyRemaining: number;
  stockUom: string;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export class BatchService {
  private db = getDb();

  /** True if the product is batch-tracked (require_batch_number). */
  async isBatchTracked(productId: string, companyId = getSingletonCompanyId()): Promise<boolean> {
    const p = await this.db.query.products.findFirst({
      where: and(eq(products.id, productId), eq(products.companyId, companyId)),
      columns: { requireBatchNumber: true },
    });
    return !!p?.requireBatchNumber;
  }

  /** Create (or top up) a batch. Idempotent-ish: an existing code at the same
   *  product/site adds to its remaining + original. */
  async receive(input: ReceiveBatchInput): Promise<StockBatch> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    const existing = await this.db.query.stockBatches.findFirst({
      where: and(
        eq(stockBatches.companyId, companyId),
        eq(stockBatches.productId, input.productId),
        eq(stockBatches.siteId, input.siteId),
        eq(stockBatches.batchCode, input.batchCode),
      ),
    });
    if (existing) {
      const [row] = await this.db
        .update(stockBatches)
        .set({
          originalQty: String(round3(Number(existing.originalQty) + input.qty)),
          qtyRemaining: String(round3(Number(existing.qtyRemaining) + input.qty)),
          useBy: input.useBy ?? existing.useBy,
          updatedAt: new Date(),
        })
        .where(eq(stockBatches.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await this.db
      .insert(stockBatches)
      .values({
        companyId,
        productId: input.productId,
        siteId: input.siteId,
        batchCode: input.batchCode,
        useBy: input.useBy ?? null,
        originalQty: String(round3(input.qty)),
        qtyRemaining: String(round3(input.qty)),
        unitCost: input.unitCost != null ? String(input.unitCost) : null,
        currencyCode: input.currencyCode ?? 'GBP',
      })
      .returning();
    return row!;
  }

  /**
   * Decrement `qty` across the (product, site)'s batches first-expiry-first-out:
   * earliest `use_by` first (NULLs last), then earliest received. Returns the
   * per-batch allocations actually consumed (may be short if under-stocked).
   */
  async decrementFEFO(params: {
    productId: string;
    siteId: string;
    qty: number;
    companyId?: string;
  }): Promise<FefoAllocation[]> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    if (params.qty <= 0) return [];
    const open = await this.db
      .select()
      .from(stockBatches)
      .where(
        and(
          eq(stockBatches.companyId, companyId),
          eq(stockBatches.productId, params.productId),
          eq(stockBatches.siteId, params.siteId),
          gt(stockBatches.qtyRemaining, '0'),
        ),
      )
      // NULL use_by sorts last (FEFO consumes dated lots first).
      .orderBy(sql`${stockBatches.useBy} ASC NULLS LAST`, asc(stockBatches.receivedAt));

    let remaining = round3(params.qty);
    const allocations: FefoAllocation[] = [];
    for (const batch of open) {
      if (remaining <= 0) break;
      const avail = Number(batch.qtyRemaining);
      const take = Math.min(avail, remaining);
      if (take <= 0) continue;
      await this.db
        .update(stockBatches)
        .set({ qtyRemaining: String(round3(avail - take)), updatedAt: new Date() })
        .where(eq(stockBatches.id, batch.id));
      allocations.push({ batchId: batch.id, batchCode: batch.batchCode, useBy: batch.useBy, qty: round3(take) });
      remaining = round3(remaining - take);
    }
    return allocations;
  }

  /** Total remaining across a product's batches at a site. */
  async available(productId: string, siteId: string, companyId = getSingletonCompanyId()): Promise<number> {
    const [row] = await this.db
      .select({ sum: sql<string>`coalesce(sum(${stockBatches.qtyRemaining}), 0)` })
      .from(stockBatches)
      .where(
        and(
          eq(stockBatches.companyId, companyId),
          eq(stockBatches.productId, productId),
          eq(stockBatches.siteId, siteId),
        ),
      );
    return Number(row?.sum ?? 0);
  }

  /** Batches past their use-by as of a date, with stock still remaining. */
  async expired(params: { asOf: string; siteId?: string; companyId?: string }): Promise<StockBatch[]> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const where = [
      eq(stockBatches.companyId, companyId),
      gt(stockBatches.qtyRemaining, '0'),
      sql`${stockBatches.useBy} IS NOT NULL AND ${stockBatches.useBy} < ${params.asOf}`,
    ];
    if (params.siteId) where.push(eq(stockBatches.siteId, params.siteId));
    return this.db
      .select()
      .from(stockBatches)
      .where(and(...where))
      .orderBy(asc(stockBatches.useBy));
  }

  /** Batches expiring within `withinDays` of `asOf` (not yet expired). */
  async expiringSoon(params: {
    asOf: string;
    withinDays: number;
    siteId?: string;
    companyId?: string;
  }): Promise<StockBatch[]> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const where = [
      eq(stockBatches.companyId, companyId),
      gt(stockBatches.qtyRemaining, '0'),
      sql`${stockBatches.useBy} IS NOT NULL
          AND ${stockBatches.useBy} >= ${params.asOf}
          AND ${stockBatches.useBy} <= (${params.asOf}::date + ${params.withinDays} * interval '1 day')`,
    ];
    if (params.siteId) where.push(eq(stockBatches.siteId, params.siteId));
    return this.db
      .select()
      .from(stockBatches)
      .where(and(...where))
      .orderBy(asc(stockBatches.useBy));
  }

  /** Expiry report for the reports surface: expired + soon-to-expire lots,
   *  enriched with product/site names, worst (soonest) first. */
  async expiryReport(params: {
    asOf: string;
    withinDays?: number;
    siteId?: string;
    companyId?: string;
  }): Promise<{ expired: EnrichedBatch[]; expiringSoon: EnrichedBatch[] }> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const withinDays = params.withinDays ?? 7;
    const enrich = async (batches: StockBatch[]): Promise<EnrichedBatch[]> => {
      if (batches.length === 0) return [];
      const productRows = await this.db
        .select({ id: products.id, name: products.name, uom: products.stockUom })
        .from(products)
        .where(eq(products.companyId, companyId));
      const names = new Map(productRows.map((p) => [p.id, p]));
      return batches.map((b) => ({
        batchId: b.id,
        batchCode: b.batchCode,
        productId: b.productId,
        productName: names.get(b.productId)?.name ?? b.productId.slice(0, 8),
        siteId: b.siteId,
        useBy: b.useBy,
        qtyRemaining: Number(b.qtyRemaining),
        stockUom: names.get(b.productId)?.uom ?? 'each',
      }));
    };
    return {
      expired: await enrich(await this.expired(params)),
      expiringSoon: await enrich(await this.expiringSoon({ ...params, withinDays })),
    };
  }

  async listForProduct(productId: string, siteId: string, companyId = getSingletonCompanyId()): Promise<StockBatch[]> {
    return this.db
      .select()
      .from(stockBatches)
      .where(
        and(
          eq(stockBatches.companyId, companyId),
          eq(stockBatches.productId, productId),
          eq(stockBatches.siteId, siteId),
        ),
      )
      .orderBy(sql`${stockBatches.useBy} ASC NULLS LAST`);
  }
}
