/**
 * Item model & UoM persistence (P3, spec §A3).
 *
 * Proves: a product carries the new item-kind / sold-stocked / UoM fields and
 * auto-populates `barcode` from `ean`; and a fungible product mapped to two
 * supplier brands resolves to the lowest-priority one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { products, supplierProducts, suppliers } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { ProductService } from '../products/product.service.js';
import { preferredSupplierProduct } from './supplier-products.js';

const COMPANY = getSingletonCompanyId();
const service = new ProductService();
const SLUGS = ['rtest-sugar', 'rtest-cookie'];
const SUPPLIER_NAMES = ['Rtest Supplier Cheap', 'Rtest Supplier Dear'];

const createdProductIds: string[] = [];
const createdSupplierIds: string[] = [];

async function cleanup(): Promise<void> {
  const db = getDb();
  if (createdProductIds.length) {
    await db.delete(supplierProducts).where(inArray(supplierProducts.productId, createdProductIds));
    await db.delete(products).where(inArray(products.id, createdProductIds));
  }
  await db.delete(products).where(inArray(products.slug, SLUGS));
  await db.delete(suppliers).where(inArray(suppliers.name, SUPPLIER_NAMES));
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await closeDatabase();
});

describe('product item model + UoM', () => {
  it('persists item kind, flags and UoM, and auto-populates barcode from ean', async () => {
    const product = await service.create(COMPANY, {
      name: 'Regular white sugar',
      slug: 'rtest-sugar',
      ean: '5012345678900',
      itemKind: 'INGREDIENT',
      isSold: false,
      isStocked: true,
      stockUom: 'g',
      purchaseUom: 'bag',
      purchasePackSize: 1,
      purchaseToStockFactor: 1000,
      expectedNextCost: 0,
      productType: 'PHYSICAL',
      requireSerialNumber: false,
      requireBatchNumber: false,
    });
    createdProductIds.push(product!.id);

    expect(product!.itemKind).toBe('INGREDIENT');
    expect(product!.isSold).toBe(false);
    expect(product!.isStocked).toBe(true);
    expect(product!.stockUom).toBe('g');
    expect(product!.purchaseUom).toBe('bag');
    expect(Number(product!.purchaseToStockFactor)).toBe(1000);
    // barcode auto-filled from ean.
    expect(product!.barcode).toBe('5012345678900');
  });

  it('defaults a discrete retail product to whole-unit tracking', async () => {
    const product = await service.create(COMPANY, {
      name: 'Branded cookie',
      slug: 'rtest-cookie',
      expectedNextCost: 0,
      productType: 'PHYSICAL',
      requireSerialNumber: false,
      requireBatchNumber: false,
    });
    createdProductIds.push(product!.id);
    // Defaults from the schema: RETAIL, sold+stocked, stock_uom 'each'.
    expect(product!.itemKind).toBe('RETAIL');
    expect(product!.isSold).toBe(true);
    expect(product!.stockUom).toBe('each');
  });

  it('resolves a fungible product with two supplier brands to the lowest priority', async () => {
    const db = getDb();
    const productId = createdProductIds[0]!; // the sugar
    const [cheap] = await db
      .insert(suppliers)
      .values({ companyId: COMPANY, name: SUPPLIER_NAMES[0]!, slug: 'rtest-supplier-cheap' })
      .returning();
    const [dear] = await db
      .insert(suppliers)
      .values({ companyId: COMPANY, name: SUPPLIER_NAMES[1]!, slug: 'rtest-supplier-dear' })
      .returning();
    createdSupplierIds.push(cheap!.id, dear!.id);

    // Two brands map to the same sugar line; the priority-50 one wins.
    await db.insert(supplierProducts).values([
      {
        companyId: COMPANY,
        productId,
        supplierId: dear!.id,
        supplierSku: 'DEAR-SUGAR-2KG',
        costGbp: '3.20',
        priority: 100,
      },
      {
        companyId: COMPANY,
        productId,
        supplierId: cheap!.id,
        supplierSku: 'CHEAP-SUGAR-1KG',
        costGbp: '1.40',
        priority: 50,
      },
    ]);

    const preferred = await preferredSupplierProduct(productId, COMPANY);
    expect(preferred).not.toBeNull();
    expect(preferred!.supplierId).toBe(cheap!.id);
    expect(preferred!.supplierSku).toBe('CHEAP-SUGAR-1KG');
  });
});
