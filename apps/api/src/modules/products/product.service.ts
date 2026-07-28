import { and, count, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  productCategoryMappings,
  productGroups,
  productImages,
  products,
  recipeLines,
  recipes,
  sites,
  stockItems,
  stockLevels,
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
/**
 * Why a product cannot be deleted, with enough detail to act on.
 *
 * A bare "cannot delete, product is in use" makes the user hunt through five
 * sites and every recipe to find out why. This carries the actual sites and
 * quantities, and the actual recipes, so the message can say where to go.
 */
export class ProductInUseError extends Error {
  constructor(
    readonly productName: string,
    readonly stock: Array<{ siteName: string; onHand: string; stockUom: string }>,
    readonly recipeUses: Array<{ recipeId: string; bake: string; siteName: string; version: number }>,
  ) {
    super(ProductInUseError.describe(productName, stock, recipeUses));
    this.name = 'ProductInUseError';
  }

  static describe(
    productName: string,
    stock: Array<{ siteName: string; onHand: string; stockUom: string }>,
    recipeUses: Array<{ recipeId: string; bake: string; siteName: string; version: number }>,
  ): string {
    const parts: string[] = [];
    if (stock.length) {
      const where = stock
        .map((s) => `${s.siteName} (${Number(s.onHand)} ${s.stockUom})`)
        .join(', ');
      parts.push(
        `it still has stock at ${stock.length === 1 ? '' : `${stock.length} sites: `}${where}`,
      );
    }
    if (recipeUses.length) {
      const where = recipeUses
        .map((r) => `${r.bake} (${r.siteName}, v${r.version})`)
        .join(', ');
      parts.push(
        `it is an ingredient in ${recipeUses.length === 1 ? '' : `${recipeUses.length} recipes: `}${where}`,
      );
    }
    const why = parts.join(', and ');
    const fix = [
      stock.length ? 'adjust the stock to zero' : null,
      recipeUses.length ? 'remove it from those recipes' : null,
    ]
      .filter(Boolean)
      .join(' and ');
    return `“${productName}” cannot be deleted because ${why}. To delete it, ${fix} first.`;
  }
}

export class ProductService {
  private db = getDb();

  // ----------------------------------------------------------------
  // List / Search
  // ----------------------------------------------------------------

  async list(companyId: string, query: ProductQueryInput) {
    const { page, pageSize, search, categoryId, manufacturerId, productType, itemKind } = query;
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
    // Recipes consume ingredients and packaging, never retail stock or
    // cleaning supplies — the picker asks for the kinds it can legitimately
    // offer rather than filtering a page after the fact and coming up short.
    if (itemKind?.length) conditions.push(inArray(products.itemKind, itemKind));

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
        // Auto-Stock item model + UoM (spec §A3). barcode defaults from ean
        // when not given so scan-to-find works for existing EAN'd products.
        ...(input.itemKind !== undefined ? { itemKind: input.itemKind } : {}),
        ...(input.isSold !== undefined ? { isSold: input.isSold } : {}),
        ...(input.isStocked !== undefined ? { isStocked: input.isStocked } : {}),
        barcode: input.barcode ?? input.ean ?? null,
        bumblebeeProductId: input.bumblebeeProductId ?? null,
        referenceImageUrl: input.referenceImageUrl ?? null,
        imageCaptureStore: input.imageCaptureStore ?? null,
        ...(input.stockUom !== undefined ? { stockUom: input.stockUom } : {}),
        purchaseUom: input.purchaseUom ?? null,
        ...(input.purchasePackSize !== undefined
          ? { purchasePackSize: input.purchasePackSize.toString() }
          : {}),
        ...(input.purchaseToStockFactor !== undefined
          ? { purchaseToStockFactor: input.purchaseToStockFactor.toString() }
          : {}),
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
    // Auto-Stock item model + UoM
    if (input.itemKind !== undefined) updateData.itemKind = input.itemKind;
    if (input.isSold !== undefined) updateData.isSold = input.isSold;
    if (input.isStocked !== undefined) updateData.isStocked = input.isStocked;
    if (input.barcode !== undefined) updateData.barcode = input.barcode;
    if (input.bumblebeeProductId !== undefined) updateData.bumblebeeProductId = input.bumblebeeProductId;
    if (input.referenceImageUrl !== undefined) updateData.referenceImageUrl = input.referenceImageUrl;
    if (input.imageCaptureStore !== undefined) updateData.imageCaptureStore = input.imageCaptureStore;
    if (input.stockUom !== undefined) updateData.stockUom = input.stockUom;
    if (input.purchaseUom !== undefined) updateData.purchaseUom = input.purchaseUom;
    if (input.purchasePackSize !== undefined) updateData.purchasePackSize = input.purchasePackSize.toString();
    if (input.purchaseToStockFactor !== undefined)
      updateData.purchaseToStockFactor = input.purchaseToStockFactor.toString();

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

  /**
   * Soft-delete a product, unless something still depends on it.
   *
   * Two blocks, both learned the hard way. Deleting a product that a recipe
   * uses leaves that recipe silently expecting less — a bake form that asks
   * for nothing, and a materials cost that quietly drops. Deleting one that
   * still has stock strands the count: the ledger keeps a balance for an item
   * that no longer appears anywhere to be counted or reconciled.
   *
   * @throws ProductInUseError naming the sites and recipes involved.
   */
  async delete(id: string, companyId: string): Promise<boolean> {
    const product = await this.db.query.products.findFirst({
      where: and(eq(products.id, id), eq(products.companyId, companyId), isNull(products.deletedAt)),
      columns: { id: true, name: true },
    });
    if (!product) return false;

    const today = new Date().toISOString().slice(0, 10);

    const [levels, siteRows, uses] = await Promise.all([
      this.db
        .select({
          siteId: stockLevels.siteId,
          onHand: stockLevels.onHand,
        })
        .from(stockLevels)
        .where(and(eq(stockLevels.companyId, companyId), eq(stockLevels.productId, id))),
      this.db.query.sites.findMany({ where: eq(sites.companyId, companyId) }),
      this.db
        .select({
          recipeId: recipes.id,
          bake: recipes.bake,
          siteId: recipes.siteId,
          version: recipes.version,
          effectiveTo: recipes.effectiveTo,
        })
        .from(recipeLines)
        .innerJoin(recipes, eq(recipeLines.recipeId, recipes.id))
        .where(and(eq(recipeLines.companyId, companyId), eq(recipeLines.productId, id))),
    ]);

    const siteName = (siteId: string | null) =>
      siteId ? (siteRows.find((s) => s.id === siteId)?.name ?? siteId.slice(0, 8)) : 'Global';

    // Any non-zero balance counts — a negative one is a discrepancy that still
    // needs resolving, not a reason to let the product vanish.
    const stock = levels
      .filter((l) => Number(l.onHand) !== 0)
      .map((l) => ({
        siteName: siteName(l.siteId),
        onHand: String(l.onHand),
        stockUom: '',
      }));

    // An expired recipe version is history and should not block; one that is
    // still in force, or starts later, would break.
    const active = uses.filter((u) => !u.effectiveTo || u.effectiveTo >= today);
    const recipeUses = active.map((u) => ({
      recipeId: u.recipeId,
      bake: u.bake,
      siteName: siteName(u.siteId),
      version: u.version,
    }));

    if (stock.length > 0 || recipeUses.length > 0) {
      const uom = await this.db.query.products.findFirst({
        where: eq(products.id, id),
        columns: { stockUom: true },
      });
      throw new ProductInUseError(
        product.name,
        stock.map((s) => ({ ...s, stockUom: uom?.stockUom ?? '' })),
        recipeUses,
      );
    }

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
