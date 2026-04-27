/**
 * CatalogueService — read-side surface for the storefront.
 *
 * Returns only `is_published = true` rows for both groups and products.
 * Operational fields (cost, supplier, marketplace identifiers, etc.) are
 * deliberately excluded — the storefront only ever sees customer-safe shapes.
 *
 * `available_qty` is the count of `stock_items` in `IN_STOCK` status only —
 * RESERVED and ALLOCATED rows do not count as available.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { productGroups, products, stockItems } from '../../db/schema/index.js';

// ---------------------------------------------------------------------------
// Public-safe shapes
// ---------------------------------------------------------------------------

export interface ThinVariant {
  id: string;
  slug: string | null;
  colour: string | null;
  colourHex: string | null;
  priceGbp: string | null;
  availableQty: number;
  heroImageUrl: string | null;
}

export interface GroupListItem {
  id: string;
  slug: string | null;
  name: string;
  shortDescription: string | null;
  heroImageUrl: string | null;
  galleryImageUrls: string[] | null;
  seoTitle: string | null;
  seoDescription: string | null;
  sortOrder: number;
  /** Inclusive price range across published variants, or null if no variants. */
  priceRange: { min: string; max: string } | null;
  totalAvailableQty: number;
  variants: ThinVariant[];
}

export interface FullVariant extends ThinVariant {
  name: string;
  shortDescription: string | null;
  longDescription: string | null;
  galleryImageUrls: string[] | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string[] | null;
  sortOrderInGroup: number;
}

export interface FullGroup
  extends Omit<GroupListItem, 'variants'> {
  longDescription: string | null;
  seoKeywords: string[] | null;
  variants: FullVariant[];
}

export interface FullProduct extends FullVariant {
  groupId: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CatalogueService {
  private db = getDb();

  /**
   * GET /storefront/groups payload — published groups with thin variant list,
   * price range, and total available stock.
   */
  async listGroups(companyId: string): Promise<GroupListItem[]> {
    const groups = await this.db.query.productGroups.findMany({
      where: and(
        eq(productGroups.companyId, companyId),
        eq(productGroups.isPublished, true),
        isNull(productGroups.deletedAt),
      ),
      orderBy: (g, { asc }) => [asc(g.sortOrder), asc(g.name)],
    });
    if (groups.length === 0) return [];

    const groupIds = groups.map((g) => g.id);

    // Pull all published variants for these groups in a single query.
    const variantRows = await this.db.query.products.findMany({
      where: and(
        eq(products.companyId, companyId),
        eq(products.isPublished, true),
        isNull(products.deletedAt),
        inArray(products.groupId, groupIds),
      ),
      orderBy: (p, { asc }) => [asc(p.sortOrderInGroup), asc(p.name)],
    });

    // Compute per-product available_qty in one aggregate query.
    const variantIds = variantRows.map((v) => v.id);
    const stockMap = await this.availableQtyMap(companyId, variantIds);

    // Group variants by groupId.
    const variantsByGroup = new Map<string, ThinVariant[]>();
    for (const v of variantRows) {
      if (!v.groupId) continue;
      const arr = variantsByGroup.get(v.groupId) ?? [];
      arr.push({
        id: v.id,
        slug: v.slug,
        colour: v.colour,
        colourHex: v.colourHex,
        priceGbp: v.minSellingPrice ?? null,
        availableQty: stockMap.get(v.id) ?? 0,
        heroImageUrl: v.heroImageUrl,
      });
      variantsByGroup.set(v.groupId, arr);
    }

    return groups.map((g) => {
      const variants = variantsByGroup.get(g.id) ?? [];
      const prices = variants
        .map((v) => v.priceGbp)
        .filter((p): p is string => p !== null);
      const priceRange =
        prices.length > 0
          ? {
              min: prices.reduce((a, b) =>
                Number.parseFloat(a) <= Number.parseFloat(b) ? a : b,
              ),
              max: prices.reduce((a, b) =>
                Number.parseFloat(a) >= Number.parseFloat(b) ? a : b,
              ),
            }
          : null;
      return {
        id: g.id,
        slug: g.slug,
        name: g.name,
        shortDescription: g.shortDescription,
        heroImageUrl: g.heroImageUrl,
        galleryImageUrls: g.galleryImageUrls ?? null,
        seoTitle: g.seoTitle,
        seoDescription: g.seoDescription,
        sortOrder: g.sortOrder,
        priceRange,
        totalAvailableQty: variants.reduce((s, v) => s + v.availableQty, 0),
        variants,
      };
    });
  }

  /** GET /storefront/groups/:slug — full group with full variants. */
  async getGroupBySlug(companyId: string, slug: string): Promise<FullGroup | null> {
    const group = await this.db.query.productGroups.findFirst({
      where: and(
        eq(productGroups.companyId, companyId),
        eq(productGroups.slug, slug),
        eq(productGroups.isPublished, true),
        isNull(productGroups.deletedAt),
      ),
    });
    if (!group) return null;

    const variantRows = await this.db.query.products.findMany({
      where: and(
        eq(products.companyId, companyId),
        eq(products.groupId, group.id),
        eq(products.isPublished, true),
        isNull(products.deletedAt),
      ),
      orderBy: (p, { asc }) => [asc(p.sortOrderInGroup), asc(p.name)],
    });
    const stockMap = await this.availableQtyMap(
      companyId,
      variantRows.map((v) => v.id),
    );

    const variants: FullVariant[] = variantRows.map((v) => ({
      id: v.id,
      slug: v.slug,
      name: v.name,
      colour: v.colour,
      colourHex: v.colourHex,
      priceGbp: v.minSellingPrice ?? null,
      availableQty: stockMap.get(v.id) ?? 0,
      heroImageUrl: v.heroImageUrl,
      shortDescription: v.shortDescription,
      longDescription: v.longDescription,
      galleryImageUrls: v.galleryImageUrls ?? null,
      seoTitle: v.seoTitle,
      seoDescription: v.seoDescription,
      seoKeywords: v.seoKeywords ?? null,
      sortOrderInGroup: v.sortOrderInGroup,
    }));

    const prices = variants
      .map((v) => v.priceGbp)
      .filter((p): p is string => p !== null);
    const priceRange =
      prices.length > 0
        ? {
            min: prices.reduce((a, b) => (Number.parseFloat(a) <= Number.parseFloat(b) ? a : b)),
            max: prices.reduce((a, b) => (Number.parseFloat(a) >= Number.parseFloat(b) ? a : b)),
          }
        : null;

    return {
      id: group.id,
      slug: group.slug,
      name: group.name,
      shortDescription: group.shortDescription,
      longDescription: group.longDescription,
      heroImageUrl: group.heroImageUrl,
      galleryImageUrls: group.galleryImageUrls ?? null,
      seoTitle: group.seoTitle,
      seoDescription: group.seoDescription,
      seoKeywords: group.seoKeywords ?? null,
      sortOrder: group.sortOrder,
      priceRange,
      totalAvailableQty: variants.reduce((s, v) => s + v.availableQty, 0),
      variants,
    };
  }

  /** GET /storefront/products/:slug — single product (group-aware). */
  async getProductBySlug(companyId: string, slug: string): Promise<FullProduct | null> {
    const p = await this.db.query.products.findFirst({
      where: and(
        eq(products.companyId, companyId),
        eq(products.slug, slug),
        eq(products.isPublished, true),
        isNull(products.deletedAt),
      ),
    });
    if (!p) return null;
    const stockMap = await this.availableQtyMap(companyId, [p.id]);
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      colour: p.colour,
      colourHex: p.colourHex,
      priceGbp: p.minSellingPrice ?? null,
      availableQty: stockMap.get(p.id) ?? 0,
      heroImageUrl: p.heroImageUrl,
      shortDescription: p.shortDescription,
      longDescription: p.longDescription,
      galleryImageUrls: p.galleryImageUrls ?? null,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      seoKeywords: p.seoKeywords ?? null,
      sortOrderInGroup: p.sortOrderInGroup,
      groupId: p.groupId,
    };
  }

  /** GET /storefront/products?ids=<csv> — batch lookup for cart price snapshots. */
  async getProductsByIds(companyId: string, ids: string[]): Promise<FullProduct[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.query.products.findMany({
      where: and(
        eq(products.companyId, companyId),
        eq(products.isPublished, true),
        isNull(products.deletedAt),
        inArray(products.id, ids),
      ),
    });
    if (rows.length === 0) return [];
    const stockMap = await this.availableQtyMap(
      companyId,
      rows.map((r) => r.id),
    );
    return rows.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      colour: p.colour,
      colourHex: p.colourHex,
      priceGbp: p.minSellingPrice ?? null,
      availableQty: stockMap.get(p.id) ?? 0,
      heroImageUrl: p.heroImageUrl,
      shortDescription: p.shortDescription,
      longDescription: p.longDescription,
      galleryImageUrls: p.galleryImageUrls ?? null,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      seoKeywords: p.seoKeywords ?? null,
      sortOrderInGroup: p.sortOrderInGroup,
      groupId: p.groupId,
    }));
  }

  /**
   * Compute IN_STOCK count per product in one query, returning a Map.
   * RESERVED and ALLOCATED rows are excluded by design — `available_qty` is
   * what the customer can actually buy right now.
   */
  private async availableQtyMap(
    companyId: string,
    productIds: string[],
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        productId: stockItems.productId,
        n: sql<number>`count(*)::int`,
      })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          inArray(stockItems.productId, productIds),
          eq(stockItems.status, 'IN_STOCK'),
          isNull(stockItems.deletedAt),
        ),
      )
      .groupBy(stockItems.productId);
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.productId, Number(r.n));
    return map;
  }
}
