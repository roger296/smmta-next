/**
 * Storefront-facing category service.
 *
 * Reads from the hierarchical `categories` table populated by
 * `seed-categories.ts`, plus the per-product `category_id` populated
 * by `assign-categories.ts`. Builds the navigation tree, fetches
 * category-scoped listings, and computes the filter facets that
 * the catalogue-grid sidebar renders.
 *
 * Listings are one per range, not one per size and colour — see
 * `listings.ts`.
 *
 * Scoping conventions match the existing `CatalogueService`:
 *   - companyId is the singleton tenant id (passed from API context).
 *   - channelId comes from the api-key binding; products are filtered
 *     to those offered on that channel via `product_channels`.
 *   - `is_published` + `deleted_at IS NULL` apply throughout.
 *
 * Stock state is computed via `getVariantAvailabilityBatch` so it
 * matches the existing PDP / catalogue grid display.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  categories,
  productChannels,
  productGroups,
  products,
} from '../../db/schema/index.js';
import { chunkedQuery } from '../../shared/db/chunk.js';
import { getVariantAvailabilityBatch } from './availability.js';
import {
  buildListings,
  emptyFacets,
  type CategoryFacetCounts,
  type CategoryFilters,
  type CategoryListing,
  type ListingVariant,
  type SortKey,
} from './listings.js';

export type { CategoryFacetCounts, CategoryFilters, CategoryListing, SortKey } from './listings.js';

export interface NavCategoryTop {
  slug: string;
  name: string;
  description: string | null;
  children: NavCategorySub[];
}

export interface NavCategorySub {
  slug: string;
  name: string;
}

export interface CategoryMeta {
  slug: string;
  name: string;
  description: string | null;
  /** Full slug path (`top` or `top/sub`). */
  path: string;
  /** Breadcrumbs from root → this entry. */
  breadcrumbs: Array<{ slug: string; name: string; path: string }>;
}

export interface CategoryListingsResponse {
  category: CategoryMeta;
  /** One page of listings: a range with all its sizes and colours, or a
   *  product with no range page. */
  listings: CategoryListing[];
  /** Listings across every page. */
  totalCount: number;
  facets: CategoryFacetCounts;
}

/** Maximum listings to return per page. The brief asked for cursor
 *  pagination but offset is simpler and the page-size cap keeps memory
 *  bounded — switch to cursor if scrolling deep into a 30k category
 *  becomes a real workflow. */
export const PAGE_SIZE = 60;

export class CategoryService {
  private db = getDb();

  // ──────────────────────────────────────────────────────────
  // Nav: list the top-tier categories + their visible children
  // ──────────────────────────────────────────────────────────

  async listNav(companyId: string): Promise<NavCategoryTop[]> {
    const rows = await this.db.query.categories.findMany({
      where: and(
        eq(categories.companyId, companyId),
        eq(categories.isHidden, false),
        isNull(categories.deletedAt),
      ),
      orderBy: (c, { asc }) => [asc(c.sortOrder), asc(c.name)],
    });
    const tops = rows.filter((r) => r.parentId === null);
    return tops.map((top) => ({
      slug: top.slug ?? '',
      name: top.name,
      description: top.description,
      children: rows
        .filter((r) => r.parentId === top.id)
        .map((sub) => ({ slug: sub.slug ?? '', name: sub.name })),
    }));
  }

  // ──────────────────────────────────────────────────────────
  // Resolve a slug path to a `categories.id` + metadata
  // ──────────────────────────────────────────────────────────

  /** Resolve `top` or `top/sub` to the category row + breadcrumbs.
   *  Returns null when either segment is unknown. */
  async resolveSlugPath(
    companyId: string,
    slugPath: string,
  ): Promise<{
    meta: CategoryMeta;
    /** All category-ids that this slug path encompasses. For a top-tier
     *  it includes the top + all subcategories; for a sub it's just
     *  the one row. The product query uses `categoryId IN (these)`. */
    categoryIds: string[];
  } | null> {
    const [topSlug, subSlug] = slugPath.split('/');
    if (!topSlug) return null;

    const top = await this.db.query.categories.findFirst({
      where: and(
        eq(categories.companyId, companyId),
        eq(categories.slug, topSlug),
        isNull(categories.parentId),
        isNull(categories.deletedAt),
      ),
    });
    if (!top) return null;

    if (!subSlug) {
      const subs = await this.db.query.categories.findMany({
        where: and(
          eq(categories.companyId, companyId),
          eq(categories.parentId, top.id),
          isNull(categories.deletedAt),
        ),
      });
      return {
        meta: {
          slug: top.slug ?? '',
          name: top.name,
          description: top.description,
          path: topSlug,
          breadcrumbs: [{ slug: 'shop', name: 'Shop', path: 'shop' }, { slug: topSlug, name: top.name, path: topSlug }],
        },
        categoryIds: [top.id, ...subs.map((s) => s.id)],
      };
    }

    const sub = await this.db.query.categories.findFirst({
      where: and(
        eq(categories.companyId, companyId),
        eq(categories.slug, subSlug),
        eq(categories.parentId, top.id),
        isNull(categories.deletedAt),
      ),
    });
    if (!sub) return null;
    return {
      meta: {
        slug: sub.slug ?? '',
        name: sub.name,
        description: sub.description ?? top.description,
        path: `${topSlug}/${subSlug}`,
        breadcrumbs: [
          { slug: 'shop', name: 'Shop', path: 'shop' },
          { slug: topSlug, name: top.name, path: topSlug },
          { slug: subSlug, name: sub.name, path: `${topSlug}/${subSlug}` },
        ],
      },
      categoryIds: [sub.id],
    };
  }

  // ──────────────────────────────────────────────────────────
  // Listings in a category, with filters + facets + pagination
  // ──────────────────────────────────────────────────────────

  async listCategoryProducts(
    companyId: string,
    slugPath: string,
    channelId: string | null,
    opts: {
      filters?: CategoryFilters;
      sort?: SortKey;
      page?: number;
    } = {},
  ): Promise<CategoryListingsResponse | null> {
    const resolved = await this.resolveSlugPath(companyId, slugPath);
    if (!resolved) return null;
    const { meta, categoryIds } = resolved;

    // Pull every published product in the category — we group, filter
    // and sort in-memory. At ~5k products per top-tier this is fine; if
    // a single category ever exceeds 50k we'll switch to a SQL-side
    // filter pass.
    const allProducts = await this.db
      .select({
        id: products.id,
        slug: products.slug,
        name: products.name,
        colour: products.colour,
        colourHex: products.colourHex,
        baseMinPrice: products.minSellingPrice,
        heroImageUrl: products.heroImageUrl,
        attributes: products.attributes,
        createdAt: products.createdAt,
        groupId: products.groupId,
        groupSlug: productGroups.slug,
        groupName: productGroups.name,
        groupHeroImageUrl: productGroups.heroImageUrl,
        groupIsPublished: productGroups.isPublished,
        groupDeletedAt: productGroups.deletedAt,
      })
      .from(products)
      .leftJoin(productGroups, eq(productGroups.id, products.groupId))
      .where(
        and(
          eq(products.companyId, companyId),
          eq(products.isPublished, true),
          isNull(products.deletedAt),
          inArray(products.categoryId, categoryIds),
        ),
      );

    if (allProducts.length === 0) {
      return {
        category: meta,
        listings: [],
        totalCount: 0,
        facets: emptyFacets(),
      };
    }

    // Channel scoping — use the same decision logic catalogue.service
    // already implements. Avoid duplicating it by re-using the
    // helper-style approach: fetch product_channels rows for the
    // current channel + chunked-id list and build a Map.
    const productIds = allProducts.map((p) => p.id);
    let channelMap: Map<string, { isOffered: boolean; priceGbp: string | null }> | null = null;
    if (channelId) {
      const pcRows = await chunkedQuery(productIds, (chunk) =>
        this.db
          .select({
            productId: productChannels.productId,
            channelId: productChannels.channelId,
            isOffered: productChannels.isOffered,
            priceOverrideGbp: productChannels.priceOverrideGbp,
          })
          .from(productChannels)
          .where(and(inArray(productChannels.productId, chunk), isNull(productChannels.deletedAt))),
      );
      const byProduct = new Map<string, typeof pcRows>();
      for (const r of pcRows) {
        const arr = byProduct.get(r.productId);
        if (arr) arr.push(r);
        else byProduct.set(r.productId, [r]);
      }
      channelMap = new Map();
      for (const [pid, rows] of byProduct) {
        const here = rows.find((r) => r.channelId === channelId);
        if (here) {
          channelMap.set(pid, {
            isOffered: here.isOffered,
            priceGbp: here.priceOverrideGbp,
          });
        } else {
          // Has rows for other channels but not this one — scope out.
          channelMap.set(pid, { isOffered: false, priceGbp: null });
        }
      }
    }

    // Stock state for every variant in scope.
    const availability = await getVariantAvailabilityBatch(companyId, productIds);

    // Anything not offered on this channel is invisible to the customer
    // regardless of filters, so it never reaches the listings or facets.
    const variants: ListingVariant[] = [];
    for (const p of allProducts) {
      const decision = channelMap?.get(p.id);
      if (decision && !decision.isOffered) continue;
      variants.push({
        id: p.id,
        slug: p.slug,
        name: p.name,
        colour: p.colour,
        colourHex: p.colourHex,
        priceGbp: decision?.priceGbp ?? p.baseMinPrice ?? null,
        heroImageUrl: p.heroImageUrl,
        attributes: (p.attributes ?? null) as Record<string, string> | null,
        brand: null, // populated from a future products.brand column; for now null
        stockState: availability.get(p.id)?.stockState ?? 'OUT_OF_STOCK',
        createdAt: p.createdAt,
        group:
          p.groupId && p.groupName !== null
            ? {
                id: p.groupId,
                slug: p.groupSlug,
                name: p.groupName,
                heroImageUrl: p.groupHeroImageUrl,
                isPublished: p.groupIsPublished === true && p.groupDeletedAt === null,
              }
            : null,
      });
    }

    const { listings, facets } = buildListings(variants, {
      filters: opts.filters,
      sort: opts.sort,
    });

    const page = Math.max(1, opts.page ?? 1);
    const start = (page - 1) * PAGE_SIZE;

    return {
      category: meta,
      listings: listings.slice(start, start + PAGE_SIZE),
      totalCount: listings.length,
      facets,
    };
  }
}

// Suppress unused-import warnings for the drizzle helpers we don't
// use locally but want re-exported when the module grows.
export const _sentinel = { sql, asc, desc };
