/**
 * Buying-data health (supplier-ordering groundwork, plan §5.2).
 *
 * The ordering screen can only rank what it can compare: a buying option with
 * no pack size cannot be priced per kilo, one with no price cannot be priced at
 * all, and a supplier with no venue account cannot be dated. None of those
 * fail loudly — the option just quietly drops out of the comparison, or wins
 * on a July price. This lists them, worst first, so head office can work them
 * down before ordering depends on them.
 *
 * Read-only. Each list is capped (`LIMIT`) with its full count alongside,
 * because a list that silently stops at N reads as complete.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { STALE_PRICE_DAYS } from './price-observations.js';

/** A price move bigger than this, between the last two observations, is
 *  listed (decision D, default — confirm with owners). */
export const PRICE_MOVE_ALERT = 0.1;

const LIMIT = 300;

export interface OptionRow {
  supplierProductId: string;
  productId: string;
  productName: string;
  stockCode: string | null;
  supplierId: string;
  supplierName: string;
  supplierSku: string;
  costGbp: string | null;
  /** What invoices show we spent under this code in the last year — ranks
   *  the work lists by what matters. A sample, like the capture it comes from. */
  spendSeen12m: number;
  lastPrice: string | null;
  lastPriceAt: string | null;
  previousPrice: string | null;
}

export interface Listed<T> {
  total: number;
  rows: T[];
}

export interface BuyingDataHealth {
  generatedAt: string;
  thresholds: { stalePriceDays: number; priceMoveAlert: number };
  /** Stocked products nothing can be bought as. Reorder-point ones first:
   *  they will raise a proposal with no supplier. */
  noBuyingOption: Listed<{ productId: string; productName: string; stockCode: string | null; hasReorderPoint: boolean }>;
  /** Buying options with no numeric pack size — they cannot be compared per
   *  stock unit. The pack-size work list, biggest spend first. */
  packSizeMissing: Listed<OptionRow>;
  /** No typed cost and never seen on an invoice. */
  noPrice: Listed<OptionRow>;
  /** Last seen on an invoice more than `stalePriceDays` ago. */
  stalePrice: Listed<OptionRow>;
  /** The last two observations differ by more than `priceMoveAlert`. */
  priceMoves: Listed<OptionRow & { change: number }>;
  /** Suppliers with something to buy but venues that cannot be dated. */
  supplierAccounts: Listed<{
    supplierId: string;
    supplierName: string;
    options: number;
    venues: number;
    venuesDatable: number;
    spendSeen12m: number;
  }>;
}

const num = (v: unknown): number => Number(v ?? 0) || 0;
const listed = <T>(rows: T[]): Listed<T> => ({ total: rows.length, rows: rows.slice(0, LIMIT) });

export async function buyingDataHealth(companyId = getSingletonCompanyId()): Promise<BuyingDataHealth> {
  const db = getDb();

  const noOption = await db.execute(sql`
    SELECT p.id AS "productId", p.name AS "productName", p.stock_code AS "stockCode",
           EXISTS (SELECT 1 FROM stock_levels sl
                   WHERE sl.product_id = p.id AND sl.reorder_point IS NOT NULL) AS "hasReorderPoint"
    FROM products p
    WHERE p.company_id = ${companyId}
      AND p.deleted_at IS NULL
      AND p.is_stocked
      AND NOT EXISTS (SELECT 1 FROM supplier_products sp
                      WHERE sp.product_id = p.id AND sp.deleted_at IS NULL AND sp.is_active)
    ORDER BY 4 DESC, p.name
  `);

  // One row per live, active buying option, with what the price history says.
  const options = await db.execute(sql`
    WITH obs AS (
      SELECT o.supplier_product_id, o.unit_price, o.observed_at, o.quantity,
             row_number() OVER (PARTITION BY o.supplier_product_id
                                ORDER BY o.observed_at DESC, o.created_at DESC) AS rn
      FROM supplier_price_observations o
      WHERE o.company_id = ${companyId}
    ),
    spend AS (
      SELECT supplier_product_id,
             sum(unit_price * coalesce(quantity, 1))::float8 AS spend
      FROM obs
      WHERE observed_at > now() - interval '365 days'
      GROUP BY supplier_product_id
    )
    SELECT sp.id AS "supplierProductId", p.id AS "productId", p.name AS "productName",
           p.stock_code AS "stockCode", s.id AS "supplierId", s.name AS "supplierName",
           sp.supplier_sku AS "supplierSku", sp.cost_gbp AS "costGbp",
           sp.supplier_pack_size AS "packSize",
           coalesce(spend.spend, 0) AS "spendSeen12m",
           last.unit_price AS "lastPrice", last.observed_at AS "lastPriceAt",
           prev.unit_price AS "previousPrice"
    FROM supplier_products sp
    JOIN products p ON p.id = sp.product_id AND p.deleted_at IS NULL
    JOIN suppliers s ON s.id = sp.supplier_id AND s.deleted_at IS NULL
    LEFT JOIN spend ON spend.supplier_product_id = sp.id
    LEFT JOIN obs last ON last.supplier_product_id = sp.id AND last.rn = 1
    LEFT JOIN obs prev ON prev.supplier_product_id = sp.id AND prev.rn = 2
    WHERE sp.company_id = ${companyId}
      AND sp.deleted_at IS NULL
      AND sp.is_active
      -- NOSKU is a placeholder, not a code (CLAUDE.md): inert, and kept by decision.
      AND upper(btrim(sp.supplier_sku)) <> 'NOSKU'
    ORDER BY coalesce(spend.spend, 0) DESC, p.name, s.name
  `);

  const accounts = await db.execute(sql`
    SELECT s.id AS "supplierId", s.name AS "supplierName",
           count(DISTINCT sp.id)::int AS "options",
           (SELECT count(*)::int FROM sites st
            WHERE st.company_id = ${companyId} AND st.is_active) AS "venues",
           (SELECT count(*)::int FROM supplier_site_accounts a
            WHERE a.supplier_id = s.id AND a.is_active
              AND (cardinality(a.delivery_days) > 0 OR a.lead_days IS NOT NULL)) AS "venuesDatable",
           coalesce((SELECT sum(o.unit_price * coalesce(o.quantity, 1))::float8
                     FROM supplier_price_observations o
                     WHERE o.supplier_id = s.id AND o.observed_at > now() - interval '365 days'), 0)
             AS "spendSeen12m"
    FROM suppliers s
    JOIN supplier_products sp ON sp.supplier_id = s.id AND sp.deleted_at IS NULL AND sp.is_active
    WHERE s.company_id = ${companyId} AND s.deleted_at IS NULL
    GROUP BY s.id, s.name
    ORDER BY 6 DESC, 3 DESC, s.name
  `);

  const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
  const opts = (options.rows as Array<Record<string, unknown>>).map((r) => ({
    row: {
      supplierProductId: r.supplierProductId as string,
      productId: r.productId as string,
      productName: r.productName as string,
      stockCode: (r.stockCode as string | null) ?? null,
      supplierId: r.supplierId as string,
      supplierName: r.supplierName as string,
      supplierSku: r.supplierSku as string,
      costGbp: (r.costGbp as string | null) ?? null,
      spendSeen12m: Math.round(num(r.spendSeen12m) * 100) / 100,
      lastPrice: (r.lastPrice as string | null) ?? null,
      lastPriceAt: iso(r.lastPriceAt),
      previousPrice: (r.previousPrice as string | null) ?? null,
    } satisfies OptionRow,
    packSize: r.packSize as string | null,
  }));

  const staleBefore = Date.now() - STALE_PRICE_DAYS * 86_400_000;
  const moves = opts
    .filter((o) => o.row.lastPrice != null && o.row.previousPrice != null && num(o.row.previousPrice) > 0)
    .map((o) => ({ ...o.row, change: num(o.row.lastPrice) / num(o.row.previousPrice) - 1 }))
    .filter((o) => Math.abs(o.change) > PRICE_MOVE_ALERT)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const accountRows = (accounts.rows as Array<Record<string, unknown>>)
    .map((r) => ({
      supplierId: r.supplierId as string,
      supplierName: r.supplierName as string,
      options: num(r.options),
      venues: num(r.venues),
      venuesDatable: num(r.venuesDatable),
      spendSeen12m: Math.round(num(r.spendSeen12m) * 100) / 100,
    }))
    .filter((r) => r.venuesDatable < r.venues);

  return {
    generatedAt: new Date().toISOString(),
    thresholds: { stalePriceDays: STALE_PRICE_DAYS, priceMoveAlert: PRICE_MOVE_ALERT },
    noBuyingOption: listed(
      (noOption.rows as Array<Record<string, unknown>>).map((r) => ({
        productId: r.productId as string,
        productName: r.productName as string,
        stockCode: (r.stockCode as string | null) ?? null,
        hasReorderPoint: !!r.hasReorderPoint,
      })),
    ),
    packSizeMissing: listed(opts.filter((o) => o.packSize == null || num(o.packSize) <= 0).map((o) => o.row)),
    noPrice: listed(opts.filter((o) => o.row.costGbp == null && o.row.lastPrice == null).map((o) => o.row)),
    stalePrice: listed(
      opts
        .filter((o) => o.row.lastPriceAt != null && new Date(o.row.lastPriceAt).getTime() < staleBefore)
        .map((o) => o.row),
    ),
    priceMoves: listed(moves),
    supplierAccounts: listed(accountRows),
  };
}
