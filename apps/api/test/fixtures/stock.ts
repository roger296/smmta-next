/**
 * Test fixtures for reservation/stock tests.
 *
 * The reservation service expects valid `warehouse → product → stock_items`
 * rows. These helpers create / refresh those rows for a per-test company so
 * suites don't trample each other.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../src/config/database.js';
import {
  customerOrders,
  orderLines,
  products,
  stockItems,
  stockReservations,
  warehouses,
} from '../../src/db/schema/index.js';

export interface StockFixture {
  companyId: string;
  warehouseId: string;
  productId: string;
  /** IDs of the inserted stock items, in created_at order. */
  stockItemIds: string[];
}

/**
 * Wipe and reseed a test company. Returns a single product with `stockCount`
 * IN_STOCK rows. Companies are independent tenants — pass distinct companyIds
 * across tests to keep state isolated.
 */
export async function seedStockFor(
  companyId: string,
  stockCount: number,
  options: { productName?: string } = {},
): Promise<StockFixture> {
  const db = getDb();
  await wipeCompany(companyId);

  const [warehouse] = await db
    .insert(warehouses)
    .values({ companyId, name: 'Test Warehouse', isDefault: true })
    .returning({ id: warehouses.id });
  if (!warehouse) throw new Error('seed: failed to insert warehouse');

  const [product] = await db
    .insert(products)
    .values({
      companyId,
      name: options.productName ?? 'Reservation Test Product',
      stockCode: `RTP-${companyId.slice(0, 8)}`,
      productType: 'PHYSICAL',
    })
    .returning({ id: products.id });
  if (!product) throw new Error('seed: failed to insert product');

  const stockItemIds: string[] = [];
  if (stockCount > 0) {
    const rows = await db
      .insert(stockItems)
      .values(
        Array.from({ length: stockCount }).map(() => ({
          companyId,
          productId: product.id,
          warehouseId: warehouse.id,
          quantity: 1,
          status: 'IN_STOCK' as const,
          value: '10.00',
          currencyCode: 'GBP',
        })),
      )
      .returning({ id: stockItems.id });
    stockItemIds.push(...rows.map((r) => r.id));
  }

  return {
    companyId,
    warehouseId: warehouse.id,
    productId: product.id,
    stockItemIds,
  };
}

/** Convenience teardown for a single test company.
 *  Order matters: lines → orders → stock_items → reservations → products → warehouses.
 *  orderLines have no companyId, so we resolve them via the parent orders. */
export async function wipeCompany(companyId: string): Promise<void> {
  const db = getDb();
  const orders = await db
    .select({ id: customerOrders.id })
    .from(customerOrders)
    .where(eq(customerOrders.companyId, companyId));
  if (orders.length > 0) {
    const orderIds = orders.map((o) => o.id);
    await db.delete(orderLines).where(inArray(orderLines.orderId, orderIds));
  }
  await db.delete(customerOrders).where(eq(customerOrders.companyId, companyId));
  await db.delete(stockItems).where(eq(stockItems.companyId, companyId));
  await db.delete(stockReservations).where(eq(stockReservations.companyId, companyId));
  await db.delete(products).where(eq(products.companyId, companyId));
  await db.delete(warehouses).where(eq(warehouses.companyId, companyId));
}

/** Count IN_STOCK / RESERVED / ALLOCATED rows for a product. */
export async function countStockByStatus(
  companyId: string,
  productId: string,
): Promise<{ IN_STOCK: number; RESERVED: number; ALLOCATED: number }> {
  const db = getDb();
  const rows = await db
    .select({ status: stockItems.status, id: stockItems.id })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), eq(stockItems.productId, productId)));
  const out = { IN_STOCK: 0, RESERVED: 0, ALLOCATED: 0 };
  for (const r of rows) {
    if (r.status === 'IN_STOCK') out.IN_STOCK++;
    else if (r.status === 'RESERVED') out.RESERVED++;
    else if (r.status === 'ALLOCATED') out.ALLOCATED++;
  }
  return out;
}
