/**
 * DemandEstimatorService (P22, spec §9) — smarter replenishment than fixed par.
 *
 * Estimates rate-of-use from historical decrements (SALE + CONSUMPTION) per
 * (product, site) and suggests reorder levels:
 *   reorder_point  = daily usage × lead time
 *   reorder_up_to  = daily usage × (lead time + min days cover)
 * Suggestions are *advisory* — the operator accepts them via the normal
 * set-reorder-params path; nothing auto-overwrites a manual level. The reorder
 * engine only uses the estimate when a site has `demand_reorder` on.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, stockLevels, stockMovements } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export const DEMAND_DEFAULT_WINDOW_DAYS = 28;
export const DEMAND_DEFAULT_LEAD_DAYS = 3;
export const DEMAND_DEFAULT_COVER_DAYS = 7;

/** Movement types that represent demand (stock leaving to a customer / a bake). */
const DEMAND_TYPES = ['SALE', 'CONSUMPTION'] as const;

export interface DemandSuggestion {
  productId: string;
  siteId: string;
  windowDays: number;
  leadTimeDays: number;
  minDaysCover: number;
  dailyUsage: number;
  suggestedReorderPoint: number;
  suggestedReorderUpTo: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export class DemandEstimatorService {
  private db = getDb();

  /** Average daily usage over the trailing `windowDays` ending `asOf`. */
  async dailyUsage(params: {
    productId: string;
    siteId: string;
    windowDays?: number;
    asOf: string; // YYYY-MM-DD
    companyId?: string;
  }): Promise<number> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const windowDays = params.windowDays ?? DEMAND_DEFAULT_WINDOW_DAYS;
    const [row] = await this.db
      .select({
        used: sql<string>`coalesce(sum(case when ${stockMovements.qtyDelta} < 0 then -${stockMovements.qtyDelta} else 0 end), 0)`,
      })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.companyId, companyId),
          eq(stockMovements.productId, params.productId),
          eq(stockMovements.siteId, params.siteId),
          sql`${stockMovements.movementType} in ('SALE','CONSUMPTION')`,
          sql`${stockMovements.occurredAt} >= (${params.asOf}::date - ${windowDays} * interval '1 day')`,
          sql`${stockMovements.occurredAt} < (${params.asOf}::date + interval '1 day')`,
        ),
      );
    const used = Number(row?.used ?? 0);
    return round3(used / windowDays);
  }

  /** Suggested levels for one (product, site). `minDaysCover` defaults to the
   *  stored stock_levels value, else the system default. */
  async suggest(params: {
    productId: string;
    siteId: string;
    leadTimeDays?: number;
    windowDays?: number;
    minDaysCover?: number | null;
    asOf: string;
    companyId?: string;
  }): Promise<DemandSuggestion> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const windowDays = params.windowDays ?? DEMAND_DEFAULT_WINDOW_DAYS;
    const leadTimeDays = params.leadTimeDays ?? DEMAND_DEFAULT_LEAD_DAYS;
    const dailyUsage = await this.dailyUsage({ ...params, windowDays, companyId });

    let minDaysCover = params.minDaysCover ?? null;
    if (minDaysCover == null) {
      const level = await this.db.query.stockLevels.findFirst({
        where: and(
          eq(stockLevels.companyId, companyId),
          eq(stockLevels.productId, params.productId),
          eq(stockLevels.siteId, params.siteId),
        ),
        columns: { minDaysCover: true },
      });
      minDaysCover = level?.minDaysCover ?? DEMAND_DEFAULT_COVER_DAYS;
    }

    return {
      productId: params.productId,
      siteId: params.siteId,
      windowDays,
      leadTimeDays,
      minDaysCover,
      dailyUsage,
      suggestedReorderPoint: round3(dailyUsage * leadTimeDays),
      suggestedReorderUpTo: round3(dailyUsage * (leadTimeDays + minDaysCover)),
    };
  }

  /** Suggestions for every product at a site that has demand history in the
   *  window (so the operator can review + accept). */
  async suggestAll(params: {
    siteId: string;
    leadTimeDays?: number;
    windowDays?: number;
    asOf: string;
    companyId?: string;
  }): Promise<DemandSuggestion[]> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const windowDays = params.windowDays ?? DEMAND_DEFAULT_WINDOW_DAYS;
    const rows = await this.db
      .selectDistinct({ productId: stockMovements.productId })
      .from(stockMovements)
      .innerJoin(products, eq(products.id, stockMovements.productId))
      .where(
        and(
          eq(stockMovements.companyId, companyId),
          eq(stockMovements.siteId, params.siteId),
          sql`${stockMovements.movementType} in ('SALE','CONSUMPTION')`,
          sql`${stockMovements.occurredAt} >= (${params.asOf}::date - ${windowDays} * interval '1 day')`,
        ),
      );
    const out: DemandSuggestion[] = [];
    for (const r of rows) {
      out.push(await this.suggest({ ...params, productId: r.productId, windowDays, companyId }));
    }
    return out.sort((a, b) => b.dailyUsage - a.dailyUsage);
  }

  /** The demand-based order-up-to for the reorder engine (0 if no history). */
  async demandUpTo(params: {
    productId: string;
    siteId: string;
    leadTimeDays?: number;
    windowDays?: number;
    minDaysCover?: number | null;
    asOf: string;
    companyId?: string;
  }): Promise<number> {
    const s = await this.suggest(params);
    return s.suggestedReorderUpTo;
  }
}

export { DEMAND_TYPES };
