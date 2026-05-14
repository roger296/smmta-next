/**
 * Single source of truth for "is this product orderable, and how should
 * the storefront present it?".
 *
 * Three states:
 *   - IN_STOCK                 — warehouseFreeStock > 0. The PDP shows
 *                                "In stock" + "Dispatched within 1
 *                                working day". Order routing prefers
 *                                the warehouse for these.
 *   - AVAILABLE_FROM_SUPPLIER  — warehouseFreeStock = 0 and at least
 *                                one active supplier mapping has
 *                                lastKnownStock > 0. Customer-facing
 *                                copy is "Available from supplier"
 *                                + the per-supplier dispatch SLA.
 *                                Order routing places a supplier
 *                                order on payment confirmation
 *                                (§D, not in this PR).
 *   - OUT_OF_STOCK             — both warehouse and every active
 *                                supplier are at zero. The "Notify
 *                                me" form shows.
 *
 * Warehouse free stock is the same `IN_STOCK` count
 * `CatalogueService.availableQtyMap` already uses (excludes RESERVED
 * + ALLOCATED). Supplier free stock is `sum(lastKnownStock)` across
 * active mappings — we don't try to reserve supplier units in our DB,
 * so there's no in-flight to subtract.
 *
 * Both helpers do their work in single batched queries so the
 * storefront read endpoints stay O(1) regardless of catalogue size.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { stockItems, supplierProducts } from '../../db/schema/index.js';
import { chunkedQuery } from '../../shared/db/chunk.js';

export type StockState = 'IN_STOCK' | 'AVAILABLE_FROM_SUPPLIER' | 'OUT_OF_STOCK';

export interface VariantAvailability {
  productId: string;
  warehouseFreeStock: number;
  supplierFreeStock: number;
  combinedFreeStock: number;
  stockState: StockState;
}

export function deriveStockState(
  warehouseFreeStock: number,
  supplierFreeStock: number,
): StockState {
  if (warehouseFreeStock > 0) return 'IN_STOCK';
  if (supplierFreeStock > 0) return 'AVAILABLE_FROM_SUPPLIER';
  return 'OUT_OF_STOCK';
}

export async function getVariantAvailabilityBatch(
  companyId: string,
  productIds: string[],
): Promise<Map<string, VariantAvailability>> {
  const out = new Map<string, VariantAvailability>();
  if (productIds.length === 0) return out;

  const db = getDb();

  // Warehouse free-stock: count of IN_STOCK rows per product.
  // Chunked to stay under Postgres's 65535-param limit when the
  // catalogue is large (post-Ralawise-import: 100k+ products).
  const warehouseRows = await chunkedQuery(productIds, (chunk) =>
    db
      .select({
        productId: stockItems.productId,
        n: sql<number>`count(*)::int`,
      })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          inArray(stockItems.productId, chunk),
          eq(stockItems.status, 'IN_STOCK'),
          isNull(stockItems.deletedAt),
        ),
      )
      .groupBy(stockItems.productId),
  );
  const warehouseMap = new Map<string, number>();
  for (const r of warehouseRows) warehouseMap.set(r.productId, Number(r.n));

  // Supplier free-stock: sum(lastKnownStock) across active mappings.
  // Same chunking concern.
  const supplierRows = await chunkedQuery(productIds, (chunk) =>
    db
      .select({
        productId: supplierProducts.productId,
        total: sql<number>`COALESCE(SUM(${supplierProducts.lastKnownStock}), 0)::int`,
      })
      .from(supplierProducts)
      .where(
        and(
          inArray(supplierProducts.productId, chunk),
          eq(supplierProducts.isActive, true),
          isNull(supplierProducts.deletedAt),
        ),
      )
      .groupBy(supplierProducts.productId),
  );
  const supplierMap = new Map<string, number>();
  for (const r of supplierRows) supplierMap.set(r.productId, Number(r.total));

  for (const id of productIds) {
    const w = warehouseMap.get(id) ?? 0;
    const s = supplierMap.get(id) ?? 0;
    out.set(id, {
      productId: id,
      warehouseFreeStock: w,
      supplierFreeStock: s,
      combinedFreeStock: w + s,
      stockState: deriveStockState(w, s),
    });
  }
  return out;
}

export async function getVariantAvailability(
  companyId: string,
  productId: string,
): Promise<VariantAvailability> {
  const map = await getVariantAvailabilityBatch(companyId, [productId]);
  return (
    map.get(productId) ?? {
      productId,
      warehouseFreeStock: 0,
      supplierFreeStock: 0,
      combinedFreeStock: 0,
      stockState: 'OUT_OF_STOCK',
    }
  );
}
