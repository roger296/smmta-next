import { pgTable, varchar, decimal, boolean, integer, text, uuid, jsonb, doublePrecision } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps, oldId, productTypeEnum, stockItemStatusEnum } from './common.js';
import { categories, manufacturers, warehouses } from './reference.js';

// ============================================================
// Products
// ============================================================

export const products = pgTable('products', {
  id: pk(),
  companyId: companyId(),
  name: varchar('name', { length: 500 }).notNull(),
  stockCode: varchar('stock_code', { length: 100 }),
  manufacturerId: uuid('manufacturer_id').references(() => manufacturers.id),
  manufacturerPartNumber: varchar('manufacturer_part_number', { length: 100 }),
  description: text('description'),
  expectedNextCost: decimal('expected_next_cost', { precision: 18, scale: 2 }).default('0'),
  minSellingPrice: decimal('min_selling_price', { precision: 18, scale: 2 }),
  maxSellingPrice: decimal('max_selling_price', { precision: 18, scale: 2 }),
  ean: varchar('ean', { length: 50 }),
  productType: productTypeEnum('product_type').notNull().default('PHYSICAL'),
  requireSerialNumber: boolean('require_serial_number').notNull().default(false),
  requireBatchNumber: boolean('require_batch_number').notNull().default(false),
  weight: decimal('weight', { precision: 10, scale: 3 }),
  length: decimal('length', { precision: 10, scale: 2 }),
  width: decimal('width', { precision: 10, scale: 2 }),
  height: decimal('height', { precision: 10, scale: 2 }),
  countryOfOrigin: varchar('country_of_origin', { length: 3 }),
  hsCode: varchar('hs_code', { length: 20 }),
  supplierId: uuid('supplier_id'),
  defaultWarehouseId: uuid('default_warehouse_id').references(() => warehouses.id),
  marketplaceIdentifiers: jsonb('marketplace_identifiers').$type<{
    sellerSkus?: string[];
    asins?: string[];
    fnskus?: string[];
    shopifyProductId?: string;
    ebayItemId?: string;
    etsyListingId?: string;
  }>(),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Product Images
// ============================================================

export const productImages = pgTable('product_images', {
  id: pk(),
  productId: uuid('product_id').notNull().references(() => products.id),
  imageUrl: varchar('image_url', { length: 500 }).notNull(),
  priority: integer('priority').notNull().default(0),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Product Category Mappings
// ============================================================

export const productCategoryMappings = pgTable('product_category_mappings', {
  id: pk(),
  productId: uuid('product_id').notNull().references(() => products.id),
  categoryId: uuid('category_id').notNull().references(() => categories.id),
  ...auditTimestamps,
});

// ============================================================
// Product Groups
// ============================================================

export const productGroups = pgTable('product_groups', {
  id: pk(),
  companyId: companyId(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  groupType: varchar('group_type', { length: 50 }),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Stock Items
// ============================================================

export const stockItems = pgTable('stock_items', {
  id: pk(),
  companyId: companyId(),
  productId: uuid('product_id').notNull().references(() => products.id),
  serialNumber: varchar('serial_number', { length: 100 }),
  batchId: varchar('batch_id', { length: 100 }),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  locationIsle: varchar('location_isle', { length: 50 }),
  locationShelf: varchar('location_shelf', { length: 50 }),
  locationBin: varchar('location_bin', { length: 50 }),
  quantity: doublePrecision('quantity').notNull().default(1),
  status: stockItemStatusEnum('status').notNull().default('IN_STOCK'),
  bookedInDate: varchar('booked_in_date', { length: 10 }), // YYYY-MM-DD
  bookedOutDate: varchar('booked_out_date', { length: 10 }),
  purchaseOrderId: uuid('purchase_order_id'),
  salesOrderId: uuid('sales_order_id'),
  value: decimal('value', { precision: 18, scale: 2 }).default('0'),
  currencyCode: varchar('currency_code', { length: 3 }).default('GBP'),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Pallets
// ============================================================

export const pallets = pgTable('pallets', {
  id: pk(),
  companyId: companyId(),
  productId: uuid('product_id').references(() => products.id),
  productSku: varchar('product_sku', { length: 100 }),
  palletSerialNo: varchar('pallet_serial_no', { length: 100 }),
  itemCount: integer('item_count').default(0),
  isAvailable: boolean('is_available').notNull().default(true),
  orderId: uuid('order_id'),
  oldId: oldId(),
  ...auditTimestamps,
});

// ============================================================
// Relations
// ============================================================

export const productsRelations = relations(products, ({ one, many }) => ({
  manufacturer: one(manufacturers, { fields: [products.manufacturerId], references: [manufacturers.id] }),
  images: many(productImages),
  categoryMappings: many(productCategoryMappings),
  stockItems: many(stockItems),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, { fields: [productImages.productId], references: [products.id] }),
}));

export const stockItemsRelations = relations(stockItems, ({ one }) => ({
  product: one(products, { fields: [stockItems.productId], references: [products.id] }),
  warehouse: one(warehouses, { fields: [stockItems.warehouseId], references: [warehouses.id] }),
}));

export const productCategoryMappingsRelations = relations(productCategoryMappings, ({ one }) => ({
  product: one(products, { fields: [productCategoryMappings.productId], references: [products.id] }),
  category: one(categories, { fields: [productCategoryMappings.categoryId], references: [categories.id] }),
}));
