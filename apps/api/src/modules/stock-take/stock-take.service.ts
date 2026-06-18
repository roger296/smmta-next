/**
 * StockTakeService (P9, spec §A6).
 *
 * `open` snapshots book stock for the scope into lines; `recordCount(s)` writes
 * counted quantities + variance (offline-tolerant via a client idempotency
 * key); `approve` writes a STOCKTAKE_TRUE_UP movement for each varianced line
 * and posts ONE stock adjustment to Xero, then marks the take APPROVED.
 * `approve` is idempotent — re-approving an APPROVED take re-applies nothing.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  products,
  stockLevels,
  stockTakeLines,
  stockTakes,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { getStockGLService } from '../../integrations/gl-provider.js';

export type StockTake = typeof stockTakes.$inferSelect;
export type StockTakeLine = typeof stockTakeLines.$inferSelect;
export type StockTakeScope = 'FULL' | 'CATEGORY' | 'ZONE' | 'ITEM' | 'CYCLE';

export class StockTakeService {
  private db = getDb();
  private levels = new StockLevelService();

  /** Open a take, snapshotting book stock for the scope into lines. */
  async open(input: {
    siteId: string;
    scope: StockTakeScope;
    scopeRef?: string | null;
    companyId?: string;
  }): Promise<{ take: StockTake; lines: StockTakeLine[] }> {
    const companyId = input.companyId ?? getSingletonCompanyId();

    const where = [eq(stockLevels.companyId, companyId), eq(stockLevels.siteId, input.siteId)];
    if (input.scope === 'CATEGORY' && input.scopeRef) {
      where.push(eq(products.categoryId, input.scopeRef));
    } else if (input.scope === 'ITEM' && input.scopeRef) {
      where.push(eq(products.id, input.scopeRef));
    }
    // FULL / CYCLE / ZONE count everything at the site (no zone data in v1).
    const inScope = await this.db
      .select({ productId: stockLevels.productId, onHand: stockLevels.onHand })
      .from(stockLevels)
      .innerJoin(products, eq(products.id, stockLevels.productId))
      .where(and(...where));

    const [take] = await this.db
      .insert(stockTakes)
      .values({
        companyId,
        siteId: input.siteId,
        scope: input.scope,
        scopeRef: input.scopeRef ?? null,
      })
      .returning();

    const lines: StockTakeLine[] = [];
    for (const row of inScope) {
      const [line] = await this.db
        .insert(stockTakeLines)
        .values({ stockTakeId: take!.id, productId: row.productId, bookQty: row.onHand })
        .returning();
      lines.push(line!);
    }
    return { take: take!, lines };
  }

  /** Record a single count. Offline-idempotent on `countIdempotencyKey`. */
  async recordCount(input: {
    stockTakeId: string;
    productId: string;
    countedQty: number;
    countIdempotencyKey?: string;
    photoRefs?: unknown;
  }): Promise<StockTakeLine | null> {
    const line = await this.db.query.stockTakeLines.findFirst({
      where: and(
        eq(stockTakeLines.stockTakeId, input.stockTakeId),
        eq(stockTakeLines.productId, input.productId),
      ),
    });
    if (!line) return null;
    // Offline replay guard: same key already recorded → no-op.
    if (
      input.countIdempotencyKey &&
      line.countIdempotencyKey === input.countIdempotencyKey &&
      line.countedQty != null
    ) {
      return line;
    }
    const variance = input.countedQty - Number(line.bookQty);
    const [updated] = await this.db
      .update(stockTakeLines)
      .set({
        countedQty: String(input.countedQty),
        variance: String(variance),
        countIdempotencyKey: input.countIdempotencyKey ?? line.countIdempotencyKey,
        photoRefs: (input.photoRefs as Record<string, unknown> | undefined) ?? line.photoRefs,
        countedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(stockTakeLines.id, line.id))
      .returning();
    return updated ?? null;
  }

  async recordCounts(
    stockTakeId: string,
    counts: Array<{ productId: string; countedQty: number; countIdempotencyKey?: string }>,
  ): Promise<number> {
    let n = 0;
    for (const c of counts) {
      const r = await this.recordCount({ stockTakeId, ...c });
      if (r) n += 1;
    }
    return n;
  }

  /** Approve: true-up the ledger for each varianced line + post one adjustment. */
  async approve(stockTakeId: string, companyId = getSingletonCompanyId()): Promise<StockTake | null> {
    const take = await this.db.query.stockTakes.findFirst({
      where: and(eq(stockTakes.id, stockTakeId), eq(stockTakes.companyId, companyId)),
    });
    if (!take) return null;
    if (take.status !== 'OPEN') return take; // idempotent — already approved/cancelled

    const lines = await this.db
      .select()
      .from(stockTakeLines)
      .where(
        and(eq(stockTakeLines.stockTakeId, stockTakeId), isNotNull(stockTakeLines.countedQty)),
      );

    let netValue = 0;
    for (const line of lines) {
      const variance = Number(line.variance ?? 0);
      if (variance === 0) continue;
      const product = await this.db.query.products.findFirst({
        where: eq(products.id, line.productId),
      });
      const unitCost = Number(product?.expectedNextCost ?? 0);
      netValue += variance * unitCost;
      await this.levels.applyMovement({
        productId: line.productId,
        siteId: take.siteId,
        qtyDelta: variance,
        movementType: 'STOCKTAKE_TRUE_UP',
        sourceSystem: 'stocktake',
        sourceKey: `stocktake:${stockTakeId}:${line.productId}`,
        contentHash: 'true-up',
        unitCost,
        companyId,
      });
    }

    netValue = Math.round(netValue * 100) / 100;
    if (netValue !== 0) {
      await getStockGLService().postStockAdjustment(this.db, {
        companyId,
        adjustmentId: stockTakeId,
        adjustmentDate: new Date(),
        stockValue: Math.abs(netValue),
        type: netValue > 0 ? 'ADD' : 'REMOVE',
        productName: `Stock-take ${stockTakeId.slice(0, 8)}`,
      });
    }

    const [updated] = await this.db
      .update(stockTakes)
      .set({ status: 'APPROVED', approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(stockTakes.id, stockTakeId))
      .returning();
    return updated ?? null;
  }

  async get(id: string, companyId = getSingletonCompanyId()): Promise<{ take: StockTake; lines: StockTakeLine[] } | null> {
    const take = await this.db.query.stockTakes.findFirst({
      where: and(eq(stockTakes.id, id), eq(stockTakes.companyId, companyId)),
    });
    if (!take) return null;
    const lines = await this.db
      .select()
      .from(stockTakeLines)
      .where(eq(stockTakeLines.stockTakeId, id));
    return { take, lines };
  }

  async list(filter: { siteId?: string; status?: string; companyId?: string } = {}): Promise<StockTake[]> {
    const companyId = filter.companyId ?? getSingletonCompanyId();
    const where = [eq(stockTakes.companyId, companyId)];
    if (filter.siteId) where.push(eq(stockTakes.siteId, filter.siteId));
    if (filter.status) where.push(eq(stockTakes.status, filter.status as never));
    return this.db.query.stockTakes.findMany({
      where: and(...where),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    });
  }
}
