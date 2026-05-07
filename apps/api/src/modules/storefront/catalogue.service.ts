/**
 * CatalogueService — read-side surface for the storefront.
 *
 * Returns only `is_published = true` rows for both groups and products.
 * Operational fields (cost, supplier, marketplace identifiers, etc.) are
 * deliberately excluded — the storefront only ever sees customer-safe shapes.
 *
 * `available_qty` is the count of `stock_items` in `IN_STOCK` status only —
 * RESERVED and ALLOCATED rows do not count as available.
 *
 * Channel scoping: each query method takes an optional `channelId`. When
 * provided, products are filtered to those offered on that channel and the
 * `priceGbp` returned is the per-channel override (or the base when no
 * override exists). When `channelId` is null, no per-channel filtering or
 * pricing is applied — the back-compat behaviour for operator keys and
 * any storefront key minted before channels existed.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { productChannels, productGroups, products, stockItems } from '../../db/schema/index.js';

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

interface ChannelDecision {
  /** True if the product is offered on the requested channel. */
  isOffered: boolean;
  /** The price the storefront should display: override OR base. */
  priceGbp: string | null;
}

export class CatalogueService {
  private db = getDb();

  async listGroups(companyId: string, channelId: string | null = null): Promise<GroupListItem[]> {
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

    const variantRows = await this.db.query.products.findMany({
      where: and(
        eq(products.companyId, companyId),
        eq(products.isPublished, true),
        isNull(products.deletedAt),
        inArray(products.groupId, groupIds),
      ),
      orderBy: (p, { asc }) => [asc(p.sortOrderInGroup), asc(p.name)],
    });

    const variantIds = variantRows.map((v) => v.id);
    const stockMap = await this.availableQtyMap(companyId, variantIds);
    const channelMap = await this.channelDecisionMap(variantIds, channelId);

    const variantsByGroup = new Map<string, ThinVariant[]>();
    for (const v of variantRows) {
      if (!v.groupId) continue;
      const decision = channelMap.get(v.id) ?? {
        isOffered: true,
        priceGbp: v.minSellingPrice ?? null,
      };
      if (!decision.isOffered) continue;
      const arr = variantsByGroup.get(v.groupId) ?? [];
      arr.push({
        id: v.id,
        slug: v.slug,
        colour: v.colour,
        colourHex: v.colourHex,
        priceGbp: decision.priceGbp ?? v.minSellingPrice ?? null,
        availableQty: stockMap.get(v.id) ?? 0,
        heroImageUrl: v.heroImageUrl,
      });
      variantsByGroup.set(v.groupId, arr);
    }

    return groups
      .map((g) => {
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
      })
      // Hide groups whose variants are all not-offered on this channel.
      .filter((g) => g.variants.length > 0);
  }

  async getGroupBySlug(
    companyId: string,
    slug: string,
    channelId: string | null = null,
  ): Promise<FullGroup | null> {
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
    const channelMap = await this.channelDecisionMap(
      variantRows.map((v) => v.id),
      channelId,
    );

    const variants: FullVariant[] = variantRows
      .map((v) => {
        const d = channelMap.get(v.id) ?? {
          isOffered: true,
          priceGbp: v.minSellingPrice ?? null,
        };
        return { v, d };
      })
      .filter(({ d }) => d.isOffered)
      .map(({ v, d }) => ({
        id: v.id,
        slug: v.slug,
        name: v.name,
        colour: v.colour,
        colourHex: v.colourHex,
        priceGbp: d.priceGbp ?? v.minSellingPrice ?? null,
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

    if (variants.length === 0 && channelId) {
      // Group exists but is empty for this channel — treat as missing so
      // the storefront 404s rather than rendering an empty PDP.
      return null;
    }

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

  async getProductBySlug(
    companyId: string,
    slug: string,
    channelId: string | null = null,
  ): Promise<FullProduct | null> {
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
    const channelMap = await this.channelDecisionMap([p.id], channelId);
    const decision = channelMap.get(p.id) ?? {
      isOffered: true,
      priceGbp: p.minSellingPrice ?? null,
    };
    if (!decision.isOffered) return null;
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      colour: p.colour,
      colourHex: p.colourHex,
      priceGbp: decision.priceGbp ?? p.minSellingPrice ?? null,
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

  async getProductsByIds(
    companyId: string,
    ids: string[],
    channelId: string | null = null,
  ): Promise<FullProduct[]> {
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
    const channelMap = await this.channelDecisionMap(
      rows.map((r) => r.id),
      channelId,
    );
    return rows
      .map((p) => {
        const d = channelMap.get(p.id) ?? {
          isOffered: true,
          priceGbp: p.minSellingPrice ?? null,
        };
        return { p, d };
      })
      .filter(({ d }) => d.isOffered)
      .map(({ p, d }) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        colour: p.colour,
        colourHex: p.colourHex,
        priceGbp: d.priceGbp ?? p.minSellingPrice ?? null,
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

  /**
   * Per-product channel decision map. Empty when channelId is null —
   * callers fall through to the implicit "offered at base price" default.
   * For products with no row in `product_channels`, the map omits the
   * entry; the caller's fallback supplies the implicit-default decision.
   */
  private async channelDecisionMap(
    productIds: string[],
    channelId: string | null,
  ): Promise<Map<string, ChannelDecision>> {
    if (!channelId || productIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        productId: productChannels.productId,
        isOffered: productChannels.isOffered,
        priceOverrideGbp: productChannels.priceOverrideGbp,
        basePrice: products.minSellingPrice,
      })
      .from(productChannels)
      .innerJoin(products, eq(productChannels.productId, products.id))
      .where(
        and(
          eq(productChannels.channelId, channelId),
          inArray(productChannels.productId, productIds),
          isNull(productChannels.deletedAt),
        ),
      );
    const map = new Map<string, ChannelDecision>();
    for (const r of rows) {
      map.set(r.productId, {
        isOffered: r.isOffered,
        priceGbp: r.priceOverrideGbp ?? r.basePrice ?? null,
      });
    }
    return map;
  }
}
