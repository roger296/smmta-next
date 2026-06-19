import { pgTable, varchar, decimal, boolean, integer, text, uuid, jsonb, doublePrecision, index, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps, oldId, productTypeEnum, stockItemStatusEnum, itemKindEnum } from './common.js';
import { categories, manufacturers, warehouses } from './reference.js';
import { stockReservations } from './storefront.js';

// ============================================================
// Products
// ------------------------------------------------------------
// Storefront convention: products with the same `group_id` are
// colour variants of the same item. `group_id` may be NULL for
// standalone products that are not part of any group.
// ============================================================

export const products = pgTable(
  'products',
  {
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
    // Storefront fields ------------------------------------------------
    /** FK to product_groups. Nullable: a product with group_id = NULL is a standalone
     *  product (not part of any group). Products with the same group_id are colour
     *  variants of the same item. */
    groupId: uuid('group_id').references(() => productGroups.id),
    colour: varchar('colour', { length: 80 }),
    colourHex: varchar('colour_hex', { length: 7 }),
    slug: varchar('slug', { length: 200 }),
    shortDescription: varchar('short_description', { length: 280 }),
    longDescription: text('long_description'),
    heroImageUrl: varchar('hero_image_url', { length: 500 }),
    galleryImageUrls: jsonb('gallery_image_urls').$type<string[]>(),
    seoTitle: varchar('seo_title', { length: 70 }),
    seoDescription: varchar('seo_description', { length: 160 }),
    seoKeywords: jsonb('seo_keywords').$type<string[]>(),
    isPublished: boolean('is_published').notNull().default(false),
    sortOrderInGroup: integer('sort_order_in_group').notNull().default(0),
    /** Free-form per-vertical attributes. Filament Store uses
     *  `{ colour }`; Clothes Shop uses `{ size, colour }`. The
     *  storefront variant-selector reads `productGroups.attributeAxes`
     *  to know which axes to render and resolves the matching product
     *  by exact-match against this object. */
    attributes: jsonb('attributes').$type<Record<string, string>>(),
    /** Hierarchical category this product belongs to. Assigned by
     *  `assign-categories.ts` via rules in `category-mapping.ts`.
     *  Nullable so the backfill can run lazily; unassigned products
     *  fall into the hidden `uncategorised` bucket via the same
     *  script. `on delete set null` so deleting a category doesn't
     *  cascade-delete products (which would be catastrophic). */
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    /** When the supplier's image licence expires. Imported alongside
     *  the image URL from Ralawise's CSV (column 53). A future
     *  scheduled task can warn / hide products whose images are about
     *  to stop loading. Nullable: legacy products + non-image-licensed
     *  suppliers leave this NULL. */
    imageLicenceExpiresAt: timestamp('image_licence_expires_at', { withTimezone: true }),
    // ── Auto-Stock: item model + units of measure (spec §A3) ──────────
    /** MERCH / RETAIL (sold + stocked) vs INGREDIENT / PACKAGING (stocked,
     *  not sold). Existing fork products default to RETAIL. */
    itemKind: itemKindEnum('item_kind').notNull().default('RETAIL'),
    isSold: boolean('is_sold').notNull().default(true),
    isStocked: boolean('is_stocked').notNull().default(true),
    /** GTIN/EAN-13 barcode for scan-to-find + Square mapping. Distinct from
     *  the legacy `ean`, but auto-populated from it on write when present. */
    barcode: varchar('barcode', { length: 64 }),
    /** Shared product identity with BumbleBee (its `core.products.id`). The
     *  stock system is system-of-record; BumbleBee consumes a slim subset. */
    bumblebeeProductId: uuid('bumblebee_product_id'),
    /** Reference image for the future AI item-recognition work (spec §A10). */
    referenceImageUrl: varchar('reference_image_url', { length: 500 }),
    imageCaptureStore: varchar('image_capture_store', { length: 200 }),
    /** True for a bookable *experience package* (a Classic/Sweeter/Ultimate
     *  ticket) — a pricing bundle, not a cake. Used to sum a session's covers
     *  (guest count) from its order lines; the cake baked is chosen separately. */
    isExperienceBooking: boolean('is_experience_booking').notNull().default(false),
    // Units of measure -------------------------------------------------
    /** Tracking unit (e.g. `g`, `each`). Recipes + reorder operate in this. */
    stockUom: varchar('stock_uom', { length: 20 }).notNull().default('each'),
    /** Buying unit (e.g. `bag`). NULL ⇒ buy in the same unit as stock. */
    purchaseUom: varchar('purchase_uom', { length: 20 }),
    /** How many purchase units make up an order line item (e.g. a case of 6). */
    purchasePackSize: decimal('purchase_pack_size', { precision: 18, scale: 3 }).notNull().default('1'),
    /** stock_uom per 1 purchase_uom (e.g. 1 bag = 1000 g ⇒ 1000). */
    purchaseToStockFactor: decimal('purchase_to_stock_factor', { precision: 18, scale: 4 }).notNull().default('1'),
    // ------------------------------------------------------------------
    oldId: oldId(),
    ...auditTimestamps,
  },
  (t) => ({
    productsCompanySlugUnq: uniqueIndex('products_company_id_slug_unq').on(t.companyId, t.slug),
    productsGroupIdIdx: index('products_group_id_idx').on(t.groupId),
    productsBumblebeeIdIdx: index('products_bumblebee_id_idx').on(t.bumblebeeProductId),
    productsBarcodeIdx: index('products_barcode_idx').on(t.barcode),
  }),
);

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

export const productGroups = pgTable(
  'product_groups',
  {
    id: pk(),
    companyId: companyId(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    groupType: varchar('group_type', { length: 50 }),
    // Storefront fields ------------------------------------------------
    slug: varchar('slug', { length: 200 }),
    shortDescription: varchar('short_description', { length: 280 }),
    longDescription: text('long_description'),
    heroImageUrl: varchar('hero_image_url', { length: 500 }),
    galleryImageUrls: jsonb('gallery_image_urls').$type<string[]>(),
    seoTitle: varchar('seo_title', { length: 70 }),
    seoDescription: varchar('seo_description', { length: 160 }),
    seoKeywords: jsonb('seo_keywords').$type<string[]>(),
    isPublished: boolean('is_published').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Which attribute keys this group's variants vary along. Filament
     *  uses `['colour']`; Clothes Shop uses `['size', 'colour']`. The
     *  storefront variant-selector renders one selector per axis. */
    attributeAxes: text('attribute_axes').array(),
    // ------------------------------------------------------------------
    oldId: oldId(),
    ...auditTimestamps,
  },
  (t) => ({
    productGroupsCompanySlugUnq: uniqueIndex('product_groups_company_id_slug_unq').on(
      t.companyId,
      t.slug,
    ),
  }),
);

// ============================================================
// Stock Items
// ------------------------------------------------------------
// `reservation_id` is the back-link from a held stock unit to its
// row in `stock_reservations` (defined in storefront.ts). It is set
// only while the item is in the RESERVED status; cleared on release
// or when the reservation is converted to an ALLOCATED order.
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
  /** FK to stock_reservations.id — populated only while status='RESERVED'. */
  reservationId: uuid('reservation_id').references(() => stockReservations.id),
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
  group: one(productGroups, { fields: [products.groupId], references: [productGroups.id] }),
  images: many(productImages),
  categoryMappings: many(productCategoryMappings),
  stockItems: many(stockItems),
}));

export const productGroupsRelations = relations(productGroups, ({ many }) => ({
  products: many(products),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, { fields: [productImages.productId], references: [products.id] }),
}));

export const stockItemsRelations = relations(stockItems, ({ one }) => ({
  product: one(products, { fields: [stockItems.productId], references: [products.id] }),
  warehouse: one(warehouses, { fields: [stockItems.warehouseId], references: [warehouses.id] }),
  reservation: one(stockReservations, {
    fields: [stockItems.reservationId],
    references: [stockReservations.id],
  }),
}));

export const productCategoryMappingsRelations = relations(productCategoryMappings, ({ one }) => ({
  product: one(products, { fields: [productCategoryMappings.productId], references: [products.id] }),
  category: one(categories, { fields: [productCategoryMappings.categoryId], references: [categories.id] }),
}));
