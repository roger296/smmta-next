/**
 * Supplier-selection helpers for order routing (§D).
 *
 * V1 picks the first supplier — by `priority` ascending, `id` ascending
 * as tiebreaker — whose stock above its `stockBuffer` covers the requested
 * quantity. Cheapest-first / fastest-first / quality-rated selection are V2.
 *
 * `decideLineFulfilment` is the higher-level helper the reservation
 * service calls: given a list of cart lines, it returns one decision
 * per line (WAREHOUSE / SUPPLIER+id / impossible). Mixed-source
 * combinations (warehouse > 0 but < qty, with supplier covering the
 * gap) are rejected as `mixed_source_unsupported` per the spec —
 * line-splitting is out of scope for V1.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { stockItems, supplierProducts, suppliers } from '../../db/schema/index.js';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../shared/events/emit.js';

type Db = ReturnType<typeof getDb>;

export interface LineDecision {
  productId: string;
  qty: number;
  source: 'WAREHOUSE' | 'SUPPLIER';
  supplierId?: string;
}

export type FulfilmentDecisionError =
  | { error: 'insufficient_stock'; productId: string; available: number; requested: number }
  | { error: 'mixed_source_unsupported'; productId: string };

/**
 * The supplier to order `qty` of a product from, or null when none can
 * supply it. `available` is the most any one supplier could supply, so a
 * refusal can tell the customer how many they can have.
 *
 * Pass `db` to read inside a caller's transaction.
 */
export async function pickSupplierForProduct(
  companyId: string,
  productId: string,
  qty: number,
  db: Db | DbTx = getDb(),
): Promise<{ supplierId: string; available: number } | null> {
  const candidates = await listSupplierCandidates(companyId, productId, db);
  const picked = candidates.find((c) => c.available >= qty);
  return picked ? { supplierId: picked.supplierId, available: picked.available } : null;
}

/** The most one supplier can supply of a product, after its stock buffer. */
export async function bestSupplierAvailable(
  companyId: string,
  productId: string,
  db: Db | DbTx = getDb(),
): Promise<number> {
  const candidates = await listSupplierCandidates(companyId, productId, db);
  return candidates.reduce((max, c) => Math.max(max, c.available), 0);
}

async function listSupplierCandidates(
  companyId: string,
  productId: string,
  db: Db | DbTx,
): Promise<Array<{ supplierId: string; available: number }>> {
  const rows = await db
    .select({
      supplierId: supplierProducts.supplierId,
      lastKnownStock: supplierProducts.lastKnownStock,
      stockBuffer: suppliers.stockBuffer,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(supplierProducts.supplierId, suppliers.id))
    .where(
      and(
        eq(supplierProducts.companyId, companyId),
        eq(supplierProducts.productId, productId),
        eq(supplierProducts.isActive, true),
        isNull(supplierProducts.deletedAt),
        eq(suppliers.isDropshipActive, true),
        isNull(suppliers.deletedAt),
      ),
    )
    .orderBy(asc(supplierProducts.priority), asc(supplierProducts.id));
  return rows.map((r) => ({
    supplierId: r.supplierId,
    available: Math.max((r.lastKnownStock ?? 0) - r.stockBuffer, 0),
  }));
}

/**
 * Helper used by tests and the reservation route to count current
 * IN_STOCK rows for a product. Mirrors the catalogue service's logic
 * exactly so the routing decision and the PDP availability never
 * disagree.
 */
export async function getWarehouseFreeStock(
  companyId: string,
  productId: string,
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stockItems)
    .where(
      and(
        eq(stockItems.companyId, companyId),
        eq(stockItems.productId, productId),
        eq(stockItems.status, 'IN_STOCK'),
        isNull(stockItems.deletedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function decideLineFulfilment(
  companyId: string,
  lines: Array<{ productId: string; qty: number }>,
): Promise<{ ok: true; decisions: LineDecision[] } | { ok: false; reason: FulfilmentDecisionError }> {
  const decisions: LineDecision[] = [];
  for (const line of lines) {
    const warehouseQty = await getWarehouseFreeStock(companyId, line.productId);
    if (warehouseQty >= line.qty) {
      decisions.push({ productId: line.productId, qty: line.qty, source: 'WAREHOUSE' });
      continue;
    }
    if (warehouseQty > 0) {
      // V1 doesn't split a single line across warehouse + supplier —
      // returning `mixed_source_unsupported` lets the storefront show
      // a clear error rather than create a confusing two-shipment order.
      return {
        ok: false,
        reason: { error: 'mixed_source_unsupported', productId: line.productId },
      };
    }
    const picked = await pickSupplierForProduct(companyId, line.productId, line.qty);
    if (!picked) {
      return {
        ok: false,
        reason: {
          error: 'insufficient_stock',
          productId: line.productId,
          available: warehouseQty,
          requested: line.qty,
        },
      };
    }
    decisions.push({
      productId: line.productId,
      qty: line.qty,
      source: 'SUPPLIER',
      supplierId: picked.supplierId,
    });
  }
  return { ok: true, decisions };
}
