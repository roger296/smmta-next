/**
 * Delivery charges per parcel.
 *
 * A drop-ship basket arrives in one parcel per supplier, and each supplier
 * charges us for its parcel, so the customer pays one delivery charge per
 * parcel — however many items that parcel holds (Roger, 2026-09-15):
 *   - each supplier's parcel costs `suppliers.delivery_charge_gbp`, or the
 *     storefront's standard rate when the supplier has none set;
 *   - items from our own warehouse make one parcel at the standard rate.
 * A basket with Ralawise and Uneek items therefore pays both charges.
 *
 * Charges are VAT-inclusive, like every storefront price; the order records
 * the VAT element (order-commit.service.ts).
 */
import { and, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { suppliers, type DeliveryQuote } from '../../db/schema/index.js';
import type { DbTx } from '../../shared/events/emit.js';
import { getWarehouseFreeStock, pickSupplierForProduct } from '../suppliers/pick-supplier.js';

type Db = ReturnType<typeof getDb>;

export interface DeliveryLine {
  productId: string;
  source: 'WAREHOUSE' | 'SUPPLIER';
  supplierId?: string;
}

function toPence(amount: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid delivery charge: ${amount}`);
  return Math.round(n * 100);
}

function fromPence(pence: number): string {
  return (pence / 100).toFixed(2);
}

/**
 * The delivery quote for lines whose source is already decided.
 * `standardChargeGbp` is the storefront's own flat rate.
 */
export async function quoteDeliveryForLines(
  companyId: string,
  lines: DeliveryLine[],
  standardChargeGbp: string,
  db: Db | DbTx = getDb(),
): Promise<DeliveryQuote> {
  const standardPence = toPence(standardChargeGbp);
  const supplierIds = [...new Set(lines.flatMap((l) => (l.source === 'SUPPLIER' && l.supplierId ? [l.supplierId] : [])))];
  const supplierRows =
    supplierIds.length === 0
      ? []
      : await db
          .select({
            id: suppliers.id,
            name: suppliers.name,
            deliveryChargeGbp: suppliers.deliveryChargeGbp,
            showSupplierNameToCustomers: suppliers.showSupplierNameToCustomers,
          })
          .from(suppliers)
          .where(and(inArray(suppliers.id, supplierIds), isNull(suppliers.deletedAt)));
  const byId = new Map(supplierRows.map((s) => [s.id, s]));
  void companyId;

  // Group into parcels, keeping the order the lines came in.
  const parcels = new Map<string, { supplierId: string | null; productIds: string[] }>();
  for (const line of lines) {
    const supplierId = line.source === 'SUPPLIER' && line.supplierId ? line.supplierId : null;
    const key = supplierId ?? 'warehouse';
    const parcel = parcels.get(key) ?? { supplierId, productIds: [] };
    if (!parcel.productIds.includes(line.productId)) parcel.productIds.push(line.productId);
    parcels.set(key, parcel);
  }

  let totalPence = 0;
  const quoted = [...parcels.values()].map((p) => {
    const supplier = p.supplierId ? byId.get(p.supplierId) : undefined;
    const pence = supplier?.deliveryChargeGbp != null ? toPence(supplier.deliveryChargeGbp) : standardPence;
    totalPence += pence;
    return {
      supplierId: p.supplierId,
      supplierName: supplier?.showSupplierNameToCustomers ? supplier.name : null,
      chargeGbp: fromPence(pence),
      productIds: p.productIds,
    };
  });
  return { totalGbp: fromPence(totalPence), parcels: quoted };
}

/**
 * The delivery quote for a basket before checkout, predicting each line's
 * source the way a reservation would decide it: the warehouse when it holds
 * the whole quantity, otherwise the first supplier that can supply it. A line
 * nobody can supply is quoted at the standard rate; the reservation refuses it.
 */
export async function quoteDeliveryForBasket(
  companyId: string,
  items: Array<{ productId: string; quantity: number }>,
  standardChargeGbp: string,
): Promise<DeliveryQuote> {
  const qtyByProduct = new Map<string, number>();
  for (const item of items) {
    qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + item.quantity);
  }
  const lines: DeliveryLine[] = [];
  for (const [productId, quantity] of qtyByProduct) {
    if ((await getWarehouseFreeStock(companyId, productId)) >= quantity) {
      lines.push({ productId, source: 'WAREHOUSE' });
      continue;
    }
    const supplier = await pickSupplierForProduct(companyId, productId, quantity);
    lines.push(supplier ? { productId, source: 'SUPPLIER', supplierId: supplier.supplierId } : { productId, source: 'WAREHOUSE' });
  }
  return quoteDeliveryForLines(companyId, lines, standardChargeGbp);
}
