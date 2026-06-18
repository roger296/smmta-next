/**
 * Supplier-product resolution for stock purchasing (spec §A3, §A7).
 *
 * A fungible stock line (e.g. "Regular white sugar") can be carried by several
 * `supplier_products` — different brands / pack sizes mapping to the one
 * product. When it's time to reorder, `preferredSupplierProduct` picks the
 * active mapping with the lowest `priority` (then cheapest, then oldest).
 *
 * This is distinct from `pickSupplierForProduct` in modules/suppliers, which is
 * the storefront drop-ship resolver (needs `isDropshipActive` + live stock).
 * Big Bakes' food/merch suppliers order via emailed PO, so resolution here does
 * NOT require a drop-ship connector.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { supplierProducts } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export type SupplierProduct = typeof supplierProducts.$inferSelect;

/**
 * Effective auto-place for a supplier-product (spec §A7): the per-item
 * override wins when set; otherwise the supplier's default applies.
 */
export function effectiveAutoPlace(
  sp: { autoPlaceOverride: boolean | null },
  supplier: { autoPlace: boolean },
): boolean {
  return sp.autoPlaceOverride ?? supplier.autoPlace;
}

export async function preferredSupplierProduct(
  productId: string,
  companyId = getSingletonCompanyId(),
): Promise<SupplierProduct | null> {
  const rows = await getDb()
    .select()
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.companyId, companyId),
        eq(supplierProducts.productId, productId),
        eq(supplierProducts.isActive, true),
        isNull(supplierProducts.deletedAt),
      ),
    )
    .orderBy(
      asc(supplierProducts.priority),
      asc(supplierProducts.costGbp),
      asc(supplierProducts.id),
    )
    .limit(1);
  return rows[0] ?? null;
}
