/**
 * Booking in a purchase order, against a real database.
 *
 * The rule under test: one stock row per unit. Free stock, allocation,
 * reservations and shipping all count a row as one unit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  goodsReceivedNotes,
  grnLines,
  products,
  purchaseOrderLines,
  purchaseOrders,
  stockItems,
  suppliers,
  warehouses,
} from '../../db/schema/index.js';
import { StockItemService } from '../products/stock-item.service.js';
import { GRNService, GRNValidationError } from './grn.service.js';

const COMPANY_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '55555555-0000-4000-8000-000000000001';
const SUPPLIER_SLUG = 'grn-test-supplier';

let supplierId: string;
let warehouseId: string;
let seq = 0;

const service = () => {
  const grn = new GRNService();
  // No storefront to tell about stock coming back.
  grn.notifyMeSender = { send: async () => undefined } as unknown as GRNService['notifyMeSender'];
  return grn;
};

async function makeProduct(values: Partial<typeof products.$inferInsert> = {}) {
  seq++;
  const [product] = await getDb()
    .insert(products)
    .values({ companyId: COMPANY_ID, name: `GRN test product ${seq}`, stockCode: `GRN-TEST-${seq}`, ...values })
    .returning();
  return product!;
}

async function makePO(productId: string, quantity: number) {
  seq++;
  const db = getDb();
  const [po] = await db
    .insert(purchaseOrders)
    .values({ companyId: COMPANY_ID, supplierId, poNumber: `GRN-TEST-PO-${seq}`, deliveryWarehouseId: warehouseId })
    .returning();
  await db
    .insert(purchaseOrderLines)
    .values({ purchaseOrderId: po!.id, productId, quantity, pricePerUnit: '2.50', lineTotal: (quantity * 2.5).toFixed(2) });
  return po!.id;
}

const stockOf = (productId: string) =>
  getDb().select().from(stockItems).where(and(eq(stockItems.companyId, COMPANY_ID), eq(stockItems.productId, productId)));

async function cleanup() {
  const db = getDb();
  await db.delete(stockItems).where(eq(stockItems.companyId, COMPANY_ID));
  const grns = await db.select({ id: goodsReceivedNotes.id }).from(goodsReceivedNotes).where(eq(goodsReceivedNotes.companyId, COMPANY_ID));
  for (const g of grns) await db.delete(grnLines).where(eq(grnLines.grnId, g.id));
  await db.delete(goodsReceivedNotes).where(eq(goodsReceivedNotes.companyId, COMPANY_ID));
  const pos = await db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.companyId, COMPANY_ID));
  for (const p of pos) await db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, p.id));
  await db.delete(purchaseOrders).where(eq(purchaseOrders.companyId, COMPANY_ID));
  await db.delete(products).where(eq(products.companyId, COMPANY_ID));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY_ID));
  await db.delete(suppliers).where(eq(suppliers.slug, SUPPLIER_SLUG));
}

beforeAll(async () => {
  await cleanup();
  const db = getDb();
  const [supplier] = await db.insert(suppliers).values({ companyId: COMPANY_ID, name: 'GRN test supplier', slug: SUPPLIER_SLUG }).returning();
  supplierId = supplier!.id;
  const [wh] = await db.insert(warehouses).values({ companyId: COMPANY_ID, name: 'GRN test warehouse' }).returning();
  warehouseId = wh!.id;
});

afterAll(async () => {
  await cleanup();
  await closeDatabase();
});

describe('GRNService.bookIn', () => {
  it('writes one stock row per unit, so what is booked in can be counted and allocated', async () => {
    const product = await makeProduct();
    const poId = await makePO(product.id, 12);
    await service().bookIn(poId, COMPANY_ID, USER_ID, { lines: [{ productId: product.id, quantityBookedIn: 12 }] });

    const rows = await stockOf(product.id);
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => `${r.quantity}|${r.status}|${r.value}|${r.warehouseId}`))).toEqual(
      new Set([`1|IN_STOCK|2.50|${warehouseId}`]),
    );

    // The point of it: allocation takes 5 units and leaves 7.
    const result = await new StockItemService().allocateToOrder(COMPANY_ID, '55555555-0000-4000-8000-0000000000aa', product.id, warehouseId, 5);
    expect(result).toMatchObject({ allocated: 5, shortfall: 0 });
    expect((await stockOf(product.id)).filter((r) => r.status === 'IN_STOCK')).toHaveLength(7);
  });

  it('updates the purchase order line with what arrived', async () => {
    const product = await makeProduct();
    const poId = await makePO(product.id, 10);
    await service().bookIn(poId, COMPANY_ID, USER_ID, { lines: [{ productId: product.id, quantityBookedIn: 4 }] });
    const [line] = await getDb().select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
    expect(line).toMatchObject({ qtyBookedIn: 4, deliveryStatus: 'PARTIALLY_RECEIVED' });
  });

  it('refuses a part unit, and books nothing in', async () => {
    const product = await makeProduct();
    const poId = await makePO(product.id, 10);
    await expect(
      service().bookIn(poId, COMPANY_ID, USER_ID, { lines: [{ productId: product.id, quantityBookedIn: 2.5 }] }),
    ).rejects.toThrow(GRNValidationError);
    expect(await stockOf(product.id)).toHaveLength(0);
  });

  it('creates no stock for a service', async () => {
    const product = await makeProduct({ productType: 'SERVICE' });
    const poId = await makePO(product.id, 3);
    await service().bookIn(poId, COMPANY_ID, USER_ID, { lines: [{ productId: product.id, quantityBookedIn: 3 }] });
    expect(await stockOf(product.id)).toHaveLength(0);
  });
});
