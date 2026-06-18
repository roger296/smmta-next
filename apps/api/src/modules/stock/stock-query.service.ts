/**
 * Stock read models (P4, spec §A5): on-hand listing, valuation and low-stock.
 *
 * Valuation uses weighted-average cost (WAC) per (product, site) derived from
 * the inflow movements that carried a `unit_cost`: WAC = Σ(qty·cost) / Σ(qty)
 * over positive movements with a cost. Value = on_hand × WAC, aggregated per
 * site and per (site, item_kind).
 */
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, sites, stockLevels } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export interface StockLevelRow {
  productId: string;
  productName: string;
  itemKind: string;
  stockUom: string;
  siteId: string;
  siteName: string;
  onHand: string;
  allocated: string;
  reorderPoint: string | null;
  reorderUpTo: string | null;
}

export interface ValuationResult {
  bySite: Array<{ siteId: string; value: number }>;
  byItemKind: Array<{ siteId: string; itemKind: string; value: number }>;
  total: number;
}

export class StockQueryService {
  private db = getDb();

  /** On-hand per (product, site). Optional site + item-kind filters; `lowOnly`
   *  restricts to rows at/below their reorder point. */
  async listLevels(params: {
    siteId?: string;
    itemKind?: string;
    lowOnly?: boolean;
    companyId?: string;
  } = {}): Promise<StockLevelRow[]> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const where = [eq(stockLevels.companyId, companyId)];
    if (params.siteId) where.push(eq(stockLevels.siteId, params.siteId));
    if (params.itemKind) where.push(eq(products.itemKind, params.itemKind as never));
    if (params.lowOnly) {
      where.push(isNotNull(stockLevels.reorderPoint));
      where.push(sql`${stockLevels.onHand} <= ${stockLevels.reorderPoint}`);
    }
    return this.db
      .select({
        productId: stockLevels.productId,
        productName: products.name,
        itemKind: products.itemKind,
        stockUom: products.stockUom,
        siteId: stockLevels.siteId,
        siteName: sites.name,
        onHand: stockLevels.onHand,
        allocated: stockLevels.allocated,
        reorderPoint: stockLevels.reorderPoint,
        reorderUpTo: stockLevels.reorderUpTo,
      })
      .from(stockLevels)
      .innerJoin(products, eq(products.id, stockLevels.productId))
      .innerJoin(sites, eq(sites.id, stockLevels.siteId))
      .where(and(...where))
      .orderBy(asc(sites.name), asc(products.name));
  }

  /** Items at or below their reorder point (reorder_point must be set). */
  async lowStock(params: { siteId?: string; companyId?: string } = {}): Promise<StockLevelRow[]> {
    return this.listLevels({ ...params, lowOnly: true });
  }

  /** Weighted-average-cost valuation, aggregated per site and per (site, item_kind). */
  async valuation(params: { siteId?: string; companyId?: string } = {}): Promise<ValuationResult> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const siteFilter = params.siteId
      ? sql`AND sl.site_id = ${params.siteId}`
      : sql``;
    const res = await this.db.execute(sql`
      SELECT sl.site_id AS "siteId",
             p.item_kind AS "itemKind",
             (sl.on_hand * COALESCE(
                SUM(CASE WHEN m.qty_delta > 0 AND m.unit_cost IS NOT NULL
                         THEN m.qty_delta * m.unit_cost END)
                / NULLIF(SUM(CASE WHEN m.qty_delta > 0 AND m.unit_cost IS NOT NULL
                                  THEN m.qty_delta END), 0),
                0))::float8 AS "value"
      FROM stock_levels sl
      JOIN products p ON p.id = sl.product_id
      LEFT JOIN stock_movements m ON m.product_id = sl.product_id AND m.site_id = sl.site_id
      WHERE sl.company_id = ${companyId} ${siteFilter}
      GROUP BY sl.site_id, p.item_kind, sl.product_id, sl.on_hand
    `);
    const rows = (res.rows ?? []) as Array<{ siteId: string; itemKind: string; value: number }>;

    const bySiteMap = new Map<string, number>();
    const byKindMap = new Map<string, { siteId: string; itemKind: string; value: number }>();
    let total = 0;
    for (const r of rows) {
      const value = Number(r.value) || 0;
      total += value;
      bySiteMap.set(r.siteId, (bySiteMap.get(r.siteId) ?? 0) + value);
      const key = `${r.siteId}::${r.itemKind}`;
      const existing = byKindMap.get(key);
      if (existing) existing.value += value;
      else byKindMap.set(key, { siteId: r.siteId, itemKind: r.itemKind, value });
    }
    return {
      bySite: [...bySiteMap.entries()].map(([siteId, value]) => ({ siteId, value })),
      byItemKind: [...byKindMap.values()],
      total,
    };
  }
}
