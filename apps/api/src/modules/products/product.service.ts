import { eq, and, ilike, isNull, sql, count } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  products,
  productGroups,
  productImages,
  productCategoryMappings,
  stockItems,
} from '../../db/schema/index.js';
import type {
  CreateProductInput,
  UpdateProductInput,
  ProductQueryInput,
  CreateProductGroupInput,
  UpdateProductGroupInput,
} from './product.schema.js';
import { paginationOffset, paginationMeta } from '../../shared/utils/pagination.js';

/**
 * ProductService — CRUD and search for the product catalogue.
 *
 * Mirrors key methods from the old ProductServices.cs:
 *   GetAll, GetById, Insert, Update, Delete, checkStockCode, checkEan
 *
 * Source: Libraries/DSB.Service/Products/ProductServices.cs
 */
export class ProductService {
  private db = getDb();

  // ----------------------------------------------------------------
  // List / Search
  // ----------------------------------------------------------------

  async list(companyId: string, query: ProductQueryInput) {
    const { page, pageSize, search, categoryId, manufacturerId, productType } = query;
    const offset = paginationOffset(page, pageSize);

    const conditions = [
      eq(products.companyId, companyId),
      isNull(products.deletedAt),
    ];

    if (search) {
      conditions.push(
        sql`(${ilike(products.name, `%${search}%`)} OR ${ilike(products.stockCode, `%${search}%`)} OR ${ilike(products.ean, `%${search}%`)})`,
      );
    }
    if (manufacturerId) conditions.push(eq(products.manufacturerId, manufacturerId));
    if (productType) conditions.push(eq(products.productType, productType));

    const where = and(...conditions);

    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(products).where(where),
      this.db.query.products.findMany({
        where,
        with: { manufacturer: true, images: true },
        limit: pageSize,
        offset,
        orderBy: (p, { desc }) => [desc(p.createdAt)],
      }),
    ]);

    // If filtering by category, do a subquery join
    let filteredRows = rows;
    if (categoryId) {
      const mappedProductIds = await this.db
        .select({ productId: productCategoryMappings.productId })
        .from(productCategoryMappings)
        .where(
          and(
            eq(productCategoryMappings.categoryId, categoryId),
            isNull(productCategoryMappings.deletedAt),
          ),
        );
      const idSet = new Set(mappedProductIds.map((r) => r.productId));
      filteredRows = rows.filter((r) => idSet.has(r.id));
    }

    const total = totalResult[0]?.count ?? 0;
    return {
      data: filteredRows,
      ...paginationMeta(Number(total), page, pageSize),
    };
  }

  // ----------------------------------------------------------------
  // Get by ID (with relations)
  // ----------------------------------------------------------------

  async getById(id: string, companyId: string) {
    const product = await this.db.query.products.findFirst({
      where: and(
        eq(products.id, id),
        eq(products.companyId, companyId),
        isNull(products.deletedAt),
      ),
      with: {
        manufacturer: true,
        images: true,
        categoryMappings: true,
        stockItems: {
          where: and(
            eq(stockItems.status, 'IN_STOCK'),
            isNull(stockItems.deletedAt),
          ),
        },
      },
    });

    if (!product) return null;

    // Aggregate stock levels per warehouse
    const stockByWarehouse = await this.db
      .select({
        warehouseId: stockItems.warehouseId,
        totalQty: sql<number>`sum(${stockItems.quantity})`,
        totalValue: sql<number>`sum(cast(${stockItems.value} as numeric) * ${stockItems.quantity})`,
      })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.productId, id),
          eq(stockItems.companyId, companyId),
          eq(stockItems.status, 'IN_STOCK'),
          isNull(stockItems.deletedAt),
        ),
      )
      .groupBy(stockItems.warehouseId);

    return { ...product, stockByWarehouse };
  }

  // ----------------------------------------------------------------
  // Create
  // ----------------------------------------------------------------

  async create(companyId: string, input: CreateProductInput) {
    // Uniqueness checks (mirrors old checkStockCode, checkAsin, checkEan)
    if (input.stockCode) {
      const existing = await this.db.query.products.findFirst({
        where: and(
          eq(products.companyId, companyId),
          eq(products.stockCode, input.stockCode),
          isNull(products.deletedAt),
        ),
      });
      if (existing) {
        throw new ProductValidationError(`Stock code "${input.stockCode}" already exists`);
      }
    }

    if (input.ean) {
      const existing = await this.db.query.products.findFirst({
        where: and(
          eq(products.companyId, companyId),
          eq(products.ean, input.ean),
          isNull(products.deletedAt),
        ),
      });
      if (existing) {
        throw new ProductValidationError(`EAN "${input.ean}" already exists`);
      }
    }

    const [product] = await this.db
      .insert(products)
      .values({
        companyId,
        name: input.name,
        stockCode: input.stockCode,
        manufacturerId: input.manufacturerId,
        manufacturerPartNumber: input.manufacturerPartNumber,
        description: input.description,
        expectedNextCost: input.expectedNextCost.toString(),
        minSellingPrice: input.minSellingPrice?.toString(),
        maxSellingPrice: input.maxSellingPrice?.toString(),
        ean: input.ean,
        productType: input.productType,
        requireSerialNumber: input.requireSerialNumber,
        requireBatchNumber: input.requireBatchNumber,
        weight: input.weight?.toString(),
        length: input.length?.toString(),
        width: input.width?.toString(),
        height: input.height?.toString(),
        countryOfOrigin: input.countryOfOrigin,
        hsCode: input.hsCode,
        supplierId: input.supplierId,
        defaultWarehouseId: input.defaultWarehouseId,
        marketplaceIdentifiers: input.marketplaceIdentifiers ?? null,
        // Storefront fields — all optional; pass through nullables and let DB defaults apply.
        groupId: input.groupId ?? null,
        colour: input.colour ?? null,
        colourHex: input.colourHex ?? null,
        slug: input.slug ?? null,
        shortDescription: input.shortDescription ?? null,
        longDescription: input.longDescription ?? null,
        heroImageUrl: input.heroImageUrl ?? null,
        galleryImageUrls: input.galleryImageUrls ?? null,
        seoTitle: input.seoTitle ?? null,
        seoDescription: input.seoDescription ?? null,
        seoKeywords: input.seoKeywords ?? null,
        ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
        ...(input.sortOrderInGroup !== undefined ? { sortOrderInGroup: input.sortOrderInGroup } : {}),
      })
      .returning();

    return product;
  }

  // ----------------------------------------------------------------
  // Update
  // ----------------------------------------------------------------

  async update(id: string, companyId: string, input: UpdateProductInput) {
    const existing = await this.db.query.products.findFirst({
      where: and(eq(products.id, id), eq(products.companyId, companyId), isNull(products.deletedAt)),
    });
    if (!existing) return null;

    // Uniqueness checks on changed fields
    if (input.stockCode && input.stockCode !== existing.stockCode) {
      const dup = await this.db.query.products.findFirst({
        where: and(
          eq(products.companyId, companyId),
          eq(products.stockCode, input.stockCode),
          isNull(products.deletedAt),
        ),
      });
      if (dup && dup.id !== id) {
        throw new ProductValidationError(`Stock code "${input.stockCode}" already exists`);
      }
    }

    if (input.ean && input.ean !== existing.ean) {
      const dup = await this.db.query.products.findFirst({
        where: and(
          eq(products.companyId, companyId),
          eq(products.ean, input.ean),
          isNull(products.deletedAt),
        ),
      });
      if (dup && dup.id !== id) {
        throw new ProductValidationError(`EAN "${input.ean}" already exists`);
      }
    }

    // Build update payload — only include defined fields
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updateData.name = input.name;
    if (input.stockCode !== undefined) updateData.stockCode = input.stockCode;
    if (input.manufacturerId !== undefined) updateData.manufacturerId = input.manufacturerId;
    if (input.manufacturerPartNumber !== undefined) updateData.manufacturerPartNumber = input.manufacturerPartNumber;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.expectedNextCost !== undefined) updateData.expectedNextCost = input.expectedNextCost.toString();
    if (input.minSellingPrice !== undefined) updateData.minSellingPrice = input.minSellingPrice.toString();
    if (input.maxSellingPrice !== undefined) updateData.maxSellingPrice = input.maxSellingPrice.toString();
    if (input.ean !== undefined) updateData.ean = input.ean;
    if (input.productType !== undefined) updateData.productType = input.productType;
    if (input.requireSerialNumber !== undefined) updateData.requireSerialNumber = input.requireSerialNumber;
    if (input.requireBatchNumber !== undefined) updateData.requireBatchNumber = input.requireBatchNumber;
    if (input.weight !== undefined) updateData.weight = input.weight?.toString();
    if (input.length !== undefined) updateData.length = input.length?.toString();
    if (input.width !== undefined) updateData.width = input.width?.toString();
    if (input.height !== undefined) updateData.height = input.height?.toString();
    if (input.countryOfOrigin !== undefined) updateData.countryOfOrigin = input.countryOfOrigin;
    if (input.hsCode !== undefined) updateData.hsCode = input.hsCode;
    if (input.supplierId !== undefined) updateData.supplierId = input.supplierId;
    if (input.defaultWarehouseId !== undefined) updateData.defaultWarehouseId = input.defaultWarehouseId;
    if (input.marketplaceIdentifiers !== undefined) updateData.marketplaceIdentifiers = input.marketplaceIdentifiers;
    // Storefront fields — only set when explicitly present in the input.
    if (input.groupId !== undefined) updateData.groupId = input.groupId;
    if (input.colour !== undefined) updateData.colour = input.colour;
    if (input.colourHex !== undefined) updateData.colourHex = input.colourHex;
    if (input.slug !== undefined) updateData.slug = input.slug;
    if (input.shortDescription !== undefined) updateData.shortDescription = input.shortDescription;
    if (input.longDescription !== undefined) updateData.longDescription = input.longDescription;
    if (input.heroImageUrl !== undefined) updateData.heroImageUrl = input.heroImageUrl;
    if (input.galleryImageUrls !== undefined) updateData.galleryImageUrls = input.galleryImageUrls;
    if (input.seoTitle !== undefined) updateData.seoTitle = input.seoTitle;
    if (input.seoDescription !== undefined) updateData.seoDescription = input.seoDescription;
    if (input.seoKeywords !== undefined) updateData.seoKeywords = input.seoKeywords;
    if (input.isPublished !== undefined) updateData.isPublished = input.isPublished;
    if (input.sortOrderInGroup !== undefined) updateData.sortOrderInGroup = input.sortOrderInGroup;

    const [updated] = await this.db
      .update(products)
      .set(updateData)
      .where(and(eq(products.id, id), eq(products.companyId, companyId)))
      .returning();

    return updated;
  }

  // ----------------------------------------------------------------
  // Soft Delete
  // ----------------------------------------------------------------

  async delete(id: string, companyId: string): Promise<boolean> {
    const result = await this.db
      .update(products)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(products.id, id), eq(products.companyId, companyId), isNull(products.deletedAt)));

    return (result.rowCount ?? 0) > 0;
  }

  // ----------------------------------------------------------------
  // Images
  // ----------------------------------------------------------------

  async addImage(productId: string, imageUrl: string, priority: number) {
    const [image] = await this.db
      .insert(productImages)
      .values({ productId, imageUrl, priority })
      .returning();
    return image;
  }

  async removeImage(imageId: string) {
    const result = await this.db
      .update(productImages)
      .set({ deletedAt: new Date() })
      .where(and(eq(productImages.id, imageId), isNull(productImages.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  async getImages(productId: string) {
    return this.db.query.productImages.findMany({
      where: and(eq(productImages.productId, productId), isNull(productImages.deletedAt)),
      orderBy: (i, { asc }) => [asc(i.priority)],
    });
  }

  // ----------------------------------------------------------------
  // Stock Level Summary (aggregate across warehouses)
  // ----------------------------------------------------------------

  async getStockLevel(productId: string, companyId: string) {
    const rows = await this.db
      .select({
        warehouseId: stockItems.warehouseId,
        status: stockItems.status,
        totalQty: sql<number>`sum(${stockItems.quantity})`,
        totalValue: sql<number>`sum(cast(${stockItems.value} as numeric) * ${stockItems.quantity})`,
      })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.productId, productId),
          eq(stockItems.companyId, companyId),
          isNull(stockItems.deletedAt),
        ),
      )
      .groupBy(stockItems.warehouseId, stockItems.status);

    return rows;
  }
}

// ----------------------------------------------------------------
// Custom error
// ----------------------------------------------------------------

export class ProductValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductValidationError';
  }
}

// ================================================================
// ProductGroupService — minimal CRUD for the productGroups table.
// Used by the storefront seed script in this prompt; the admin SPA
// content-management UI lands in Prompt 6.
// ================================================================

export class ProductGroupService {
  private db = getDb();

  async list(companyId: string) {
    return this.db.query.productGroups.findMany({
      where: and(eq(productGroups.companyId, companyId), isNull(productGroups.deletedAt)),
      orderBy: (g, { asc }) => [asc(g.sortOrder), asc(g.name)],
    });
  }

  async getById(id: string, companyId: string) {
    return this.db.query.productGroups.findFirst({
      where: and(
        eq(productGroups.id, id),
        eq(productGroups.companyId, companyId),
        isNull(productGroups.deletedAt),
      ),
      with: { products: true },
    });
  }

  async create(companyId: string, input: CreateProductGroupInput) {
    const [group] = await this.db
      .insert(productGroups)
      .values({
        companyId,
        name: input.name,
        description: input.description ?? null,
        groupType: input.groupType ?? null,
        slug: input.slug ?? null,
        shortDescription: input.shortDescription ?? null,
        longDescription: input.longDescription ?? null,
        heroImageUrl: input.heroImageUrl ?? null,
        galleryImageUrls: input.galleryImageUrls ?? null,
        seoTitle: input.seoTitle ?? null,
        seoDescription: input.seoDescription ?? null,
        seoKeywords: input.seoKeywords ?? null,
        ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      })
      .returning();
    return group;
  }

  async update(id: string, companyId: string, input: UpdateProductGroupInput) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.groupType !== undefined) updateData.groupType = input.groupType;
    if (input.slug !== undefined) updateData.slug = input.slug;
    if (input.shortDescription !== undefined) updateData.shortDescription = input.shortDescription;
    if (input.longDescription !== undefined) updateData.longDescription = input.longDescription;
    if (input.heroImageUrl !== undefined) updateData.heroImageUrl = input.heroImageUrl;
    if (input.galleryImageUrls !== undefined) updateData.galleryImageUrls = input.galleryImageUrls;
    if (input.seoTitle !== undefined) updateData.seoTitle = input.seoTitle;
    if (input.seoDescription !== undefined) updateData.seoDescription = input.seoDescription;
    if (input.seoKeywords !== undefined) updateData.seoKeywords = input.seoKeywords;
    if (input.isPublished !== undefined) updateData.isPublished = input.isPublished;
    if (input.sortOrder !== undefined) updateData.sortOrder = input.sortOrder;

    const [updated] = await this.db
      .update(productGroups)
      .set(updateData)
      .where(
        and(
          eq(productGroups.id, id),
          eq(productGroups.companyId, companyId),
          isNull(productGroups.deletedAt),
        ),
      )
      .returning();
    return updated ?? null;
  }

  /** Soft-delete (sets deleted_at). Products linked via group_id keep their
   *  group_id pointing at the soft-deleted row — operators can re-publish a
   *  group later without re-linking variants if the group is restored. */
  async delete(id: string, companyId: string): Promise<boolean> {
    const result = await this.db
      .update(productGroups)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(productGroups.id, id),
          eq(productGroups.companyId, companyId),
          isNull(productGroups.deletedAt),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }
}
