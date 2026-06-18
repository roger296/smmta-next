/**
 * ConsumptionReportService (P18, spec §4/§A6).
 *
 * Triangulates the three views of usage per product/site/period:
 *   - **expected** — recipe × covers (snapshotted on each consumption line)
 *   - **actual**   — what the head-baker confirmed used (+ wastage)
 *   - **counted**  — stock-take counts (shrinkage = counted − book)
 * and derives food-cost %, portion drift (variance %), wastage hot-spots, and
 * shrinkage. Worst-first, plain-English, for a non-technical reader.
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  products,
  sessionConsumption,
  sessionConsumptionLines,
  sites,
  stockTakeLines,
  stockTakes,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export interface Period {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  siteId?: string;
  companyId?: string;
}

export interface VarianceRow {
  siteId: string;
  siteName: string;
  productId: string;
  productName: string;
  stockUom: string;
  expectedQty: number;
  actualQty: number;
  wastageQty: number;
  varianceQty: number; // actual − expected (portion drift)
  variancePct: number | null;
  expectedCost: number;
  actualCost: number;
  wastageCost: number;
  varianceCost: number; // actual − expected, in money
  shrinkageQty: number; // counted − book (stock-take), period
  shrinkageCost: number;
}

export interface WastageRow {
  siteId: string;
  siteName: string;
  productId: string;
  productName: string;
  stockUom: string;
  wastageQty: number;
  wastageCost: number;
  occurrences: number;
  reasons: string[];
}

export interface FoodCostRow {
  siteId: string;
  siteName: string;
  covers: number;
  actualCost: number;
  expectedCost: number;
  wastageCost: number;
  costPerCover: number | null;
  foodCostPct: number | null; // actualCost / revenue × 100, when revenue is known
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export class ConsumptionReportService {
  private db = getDb();

  private async siteName(companyId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(eq(sites.companyId, companyId));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async productInfo(companyId: string): Promise<Map<string, { name: string; uom: string }>> {
    const rows = await this.db
      .select({ id: products.id, name: products.name, uom: products.stockUom })
      .from(products)
      .where(eq(products.companyId, companyId));
    return new Map(rows.map((r) => [r.id, { name: r.name, uom: r.uom }]));
  }

  /** Expected vs actual vs counted variance per (product, site) for the period. */
  async consumptionVariance(period: Period): Promise<VarianceRow[]> {
    const companyId = period.companyId ?? getSingletonCompanyId();
    const where = [
      eq(sessionConsumption.companyId, companyId),
      gte(sessionConsumption.sessionDate, period.from),
      lte(sessionConsumption.sessionDate, period.to),
    ];
    if (period.siteId) where.push(eq(sessionConsumption.siteId, period.siteId));

    const consumption = await this.db
      .select({
        siteId: sessionConsumption.siteId,
        productId: sessionConsumptionLines.productId,
        expectedQty: sql<string>`coalesce(sum(${sessionConsumptionLines.expectedQty}), 0)`,
        actualQty: sql<string>`coalesce(sum(${sessionConsumptionLines.actualQty}), 0)`,
        wastageQty: sql<string>`coalesce(sum(${sessionConsumptionLines.wastageQty}), 0)`,
        expectedCost: sql<string>`coalesce(sum(${sessionConsumptionLines.expectedQty} * coalesce(${sessionConsumptionLines.unitCost}, 0)), 0)`,
        actualCost: sql<string>`coalesce(sum(${sessionConsumptionLines.actualQty} * coalesce(${sessionConsumptionLines.unitCost}, 0)), 0)`,
        wastageCost: sql<string>`coalesce(sum(${sessionConsumptionLines.wastageQty} * coalesce(${sessionConsumptionLines.unitCost}, 0)), 0)`,
        unitCost: sql<string>`coalesce(max(${sessionConsumptionLines.unitCost}), 0)`,
      })
      .from(sessionConsumptionLines)
      .innerJoin(sessionConsumption, eq(sessionConsumptionLines.consumptionId, sessionConsumption.id))
      .where(and(...where))
      .groupBy(sessionConsumption.siteId, sessionConsumptionLines.productId);

    // Shrinkage from approved stock-takes in the period.
    const takeWhere = [
      eq(stockTakes.companyId, companyId),
      eq(stockTakes.status, 'APPROVED'),
      sql`${stockTakes.approvedAt}::date >= ${period.from}`,
      sql`${stockTakes.approvedAt}::date <= ${period.to}`,
    ];
    if (period.siteId) takeWhere.push(eq(stockTakes.siteId, period.siteId));
    const shrink = await this.db
      .select({
        siteId: stockTakes.siteId,
        productId: stockTakeLines.productId,
        shrinkageQty: sql<string>`coalesce(sum(${stockTakeLines.variance}), 0)`,
      })
      .from(stockTakeLines)
      .innerJoin(stockTakes, eq(stockTakeLines.stockTakeId, stockTakes.id))
      .where(and(...takeWhere))
      .groupBy(stockTakes.siteId, stockTakeLines.productId);
    const shrinkByKey = new Map(shrink.map((s) => [`${s.siteId}:${s.productId}`, n(s.shrinkageQty)]));

    const siteNames = await this.siteName(companyId);
    const productInfo = await this.productInfo(companyId);

    const rows: VarianceRow[] = consumption.map((c) => {
      const expectedQty = n(c.expectedQty);
      const actualQty = n(c.actualQty);
      const varianceQty = round3(actualQty - expectedQty);
      const expectedCost = n(c.expectedCost);
      const actualCost = n(c.actualCost);
      const shrinkageQty = shrinkByKey.get(`${c.siteId}:${c.productId}`) ?? 0;
      const info = productInfo.get(c.productId);
      return {
        siteId: c.siteId,
        siteName: siteNames.get(c.siteId) ?? c.siteId.slice(0, 8),
        productId: c.productId,
        productName: info?.name ?? c.productId.slice(0, 8),
        stockUom: info?.uom ?? 'each',
        expectedQty: round3(expectedQty),
        actualQty: round3(actualQty),
        wastageQty: round3(n(c.wastageQty)),
        varianceQty,
        variancePct: expectedQty > 0 ? round2((varianceQty / expectedQty) * 100) : null,
        expectedCost: round2(expectedCost),
        actualCost: round2(actualCost),
        wastageCost: round2(n(c.wastageCost)),
        varianceCost: round2(actualCost - expectedCost),
        shrinkageQty: round3(shrinkageQty),
        shrinkageCost: round2(shrinkageQty * n(c.unitCost)),
      };
    });
    // Worst-first: biggest absolute money variance.
    rows.sort((a, b) => Math.abs(b.varianceCost) - Math.abs(a.varianceCost));
    return rows;
  }

  /** Wastage by product/site for the period, worst-first by cost. */
  async wastage(period: Period): Promise<WastageRow[]> {
    const companyId = period.companyId ?? getSingletonCompanyId();
    const where = [
      eq(sessionConsumption.companyId, companyId),
      gte(sessionConsumption.sessionDate, period.from),
      lte(sessionConsumption.sessionDate, period.to),
      sql`${sessionConsumptionLines.wastageQty} > 0`,
    ];
    if (period.siteId) where.push(eq(sessionConsumption.siteId, period.siteId));

    const rows = await this.db
      .select({
        siteId: sessionConsumption.siteId,
        productId: sessionConsumptionLines.productId,
        wastageQty: sql<string>`coalesce(sum(${sessionConsumptionLines.wastageQty}), 0)`,
        wastageCost: sql<string>`coalesce(sum(${sessionConsumptionLines.wastageQty} * coalesce(${sessionConsumptionLines.unitCost}, 0)), 0)`,
        occurrences: sql<string>`count(*)`,
        reasons: sql<string[]>`coalesce(array_remove(array_agg(distinct ${sessionConsumptionLines.wastageReason}), null), '{}')`,
      })
      .from(sessionConsumptionLines)
      .innerJoin(sessionConsumption, eq(sessionConsumptionLines.consumptionId, sessionConsumption.id))
      .where(and(...where))
      .groupBy(sessionConsumption.siteId, sessionConsumptionLines.productId);

    const siteNames = await this.siteName(companyId);
    const productInfo = await this.productInfo(companyId);
    const out: WastageRow[] = rows.map((r) => {
      const info = productInfo.get(r.productId);
      return {
        siteId: r.siteId,
        siteName: siteNames.get(r.siteId) ?? r.siteId.slice(0, 8),
        productId: r.productId,
        productName: info?.name ?? r.productId.slice(0, 8),
        stockUom: info?.uom ?? 'each',
        wastageQty: round3(n(r.wastageQty)),
        wastageCost: round2(n(r.wastageCost)),
        occurrences: n(r.occurrences),
        reasons: (r.reasons ?? []).filter(Boolean),
      };
    });
    out.sort((a, b) => b.wastageCost - a.wastageCost);
    return out;
  }

  /** Food cost per site for the period; food-cost % when revenue is known. */
  async foodCost(period: Period & { revenue?: number }): Promise<FoodCostRow[]> {
    const companyId = period.companyId ?? getSingletonCompanyId();
    const headWhere = [
      eq(sessionConsumption.companyId, companyId),
      gte(sessionConsumption.sessionDate, period.from),
      lte(sessionConsumption.sessionDate, period.to),
    ];
    if (period.siteId) headWhere.push(eq(sessionConsumption.siteId, period.siteId));

    const head = await this.db
      .select({
        siteId: sessionConsumption.siteId,
        covers: sql<string>`coalesce(sum(${sessionConsumption.covers}), 0)`,
        actualCost: sql<string>`coalesce(sum(${sessionConsumption.materialsCost}), 0)`,
      })
      .from(sessionConsumption)
      .where(and(...headWhere))
      .groupBy(sessionConsumption.siteId);

    const lineWhere = [
      eq(sessionConsumption.companyId, companyId),
      gte(sessionConsumption.sessionDate, period.from),
      lte(sessionConsumption.sessionDate, period.to),
    ];
    if (period.siteId) lineWhere.push(eq(sessionConsumption.siteId, period.siteId));
    const lineAgg = await this.db
      .select({
        siteId: sessionConsumption.siteId,
        expectedCost: sql<string>`coalesce(sum(${sessionConsumptionLines.expectedQty} * coalesce(${sessionConsumptionLines.unitCost}, 0)), 0)`,
        wastageCost: sql<string>`coalesce(sum(${sessionConsumptionLines.wastageQty} * coalesce(${sessionConsumptionLines.unitCost}, 0)), 0)`,
      })
      .from(sessionConsumptionLines)
      .innerJoin(sessionConsumption, eq(sessionConsumptionLines.consumptionId, sessionConsumption.id))
      .where(and(...lineWhere))
      .groupBy(sessionConsumption.siteId);
    const lineBySite = new Map(lineAgg.map((l) => [l.siteId, l]));

    const siteNames = await this.siteName(companyId);
    const rows: FoodCostRow[] = head.map((h) => {
      const covers = n(h.covers);
      const actualCost = round2(n(h.actualCost));
      const line = lineBySite.get(h.siteId);
      // Revenue only applies when a single site is requested (it's that site's).
      const foodCostPct =
        period.revenue && period.revenue > 0 && period.siteId
          ? round2((actualCost / period.revenue) * 100)
          : null;
      return {
        siteId: h.siteId,
        siteName: siteNames.get(h.siteId) ?? h.siteId.slice(0, 8),
        covers,
        actualCost,
        expectedCost: round2(n(line?.expectedCost)),
        wastageCost: round2(n(line?.wastageCost)),
        costPerCover: covers > 0 ? round2(actualCost / covers) : null,
        foodCostPct,
      };
    });
    rows.sort((a, b) => (b.foodCostPct ?? b.costPerCover ?? 0) - (a.foodCostPct ?? a.costPerCover ?? 0));
    return rows;
  }
}
