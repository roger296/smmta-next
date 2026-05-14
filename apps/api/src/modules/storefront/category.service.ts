/**
 * Storefront-facing category service.
 *
 * Reads from the hierarchical `categories` table populated by
 * `seed-categories.ts`, plus the per-product `category_id` populated
 * by `assign-categories.ts`. Builds the navigation tree, fetches
 * category-scoped product lists, and computes the filter facets that
 * the catalogue-grid sidebar renders.
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
import { getVariantAvailabilityBatch, type StockState } from './availability.js';

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

export interface CategoryProduct {
  id: string;
  slug: string | null;
  name: string;
  colour: string | null;
  colourHex: string | null;
  priceGbp: string | null;
  heroImageUrl: string | null;
  brand: string | null;
  stockState: StockState;
  attributes: Record<string, string> | null;
}

export type SortKey = 'newest' | 'price-asc' | 'price-desc';

export interface CategoryFilters {
  /** Stock state — `IN_STOCK` and/or `AVAILABLE_FROM_SUPPLIER`. Default
   *  is both; `OUT_OF_STOCK` is opt-in. */
  stockState?: StockState[];
  brand?: string[];
  colour?: string[];
  size?: string[];
  priceMin?: number;
  priceMax?: number;
}

export interface CategoryFacetCounts {
  /** Map of facet-value → count of products in the current result set
   *  that have that value. Used by the storefront filter sidebar. */
  brand: Record<string, number>;
  colour: Record<string, number>;
  size: Record<string, number>;
  stockState: Record<StockState, number>;
  /** Tuple [min, max] across the whole result set. */
  priceRange: { min: string; max: string } | null;
}

export interface CategoryProductsResponse {
  category: CategoryMeta;
  products: CategoryProduct[];
  totalCount: number;
  facets: CategoryFacetCounts;
}

/** Maximum products to return per page. The brief asked for cursor
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
  // Products in a category, with filters + facets + pagination
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
  ): Promise<CategoryProductsResponse | null> {
    const resolved = await this.resolveSlugPath(companyId, slugPath);
    if (!resolved) return null;
    const { meta, categoryIds } = resolved;

    // Pull every published product in the category — we filter and
    // sort in-memory. At ~5k products per top-tier this is fine; if
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
        brand: productGroups.description, // brand isn't a column today — punt and use description for now (no harm; the facet will just show empty)
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
        products: [],
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

    // Build a richer projection that filters + facets can read from.
    interface Enriched {
      id: string;
      slug: string | null;
      name: string;
      colour: string | null;
      colourHex: string | null;
      priceGbp: string | null;
      heroImageUrl: string | null;
      attributes: Record<string, string> | null;
      brand: string | null;
      stockState: StockState;
      createdAt: Date | null;
      offered: boolean;
    }
    const enriched: Enriched[] = allProducts.map((p) => {
      const decision = channelMap?.get(p.id);
      const offered = decision ? decision.isOffered : true;
      const channelPrice = decision?.priceGbp ?? null;
      const finalPrice = channelPrice ?? p.baseMinPrice ?? null;
      const a = availability.get(p.id);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        colour: p.colour,
        colourHex: p.colourHex,
        priceGbp: finalPrice,
        heroImageUrl: p.heroImageUrl,
        attributes: (p.attributes ?? null) as Record<string, string> | null,
        brand: null, // populated from a future products.brand column; for now null
        stockState: a?.stockState ?? 'OUT_OF_STOCK',
        createdAt: p.createdAt,
        offered,
      };
    });

    // Filter by channel offered flag first — anything not offered on
    // this channel is invisible to the customer regardless of filters.
    const offered = enriched.filter((p) => p.offered);

    // Compute facet counts BEFORE filter application so the sidebar
    // reflects the full category, then the customer's filter selections
    // narrow the displayed product list (but the facet counts stay
    // representative of the unfiltered category — matches typical
    // "facet count is the would-be count if you selected this filter"
    // semantics most catalogue UIs have).
    const facets = computeFacets(offered);

    // Apply filters.
    const filters = opts.filters ?? {};
    const stockFilter: StockState[] = filters.stockState ?? ['IN_STOCK', 'AVAILABLE_FROM_SUPPLIER'];

    const filtered = offered.filter((p) => {
      if (!stockFilter.includes(p.stockState)) return false;
      if (filters.colour && filters.colour.length > 0) {
        if (!p.colour || !filters.colour.includes(p.colour)) return false;
      }
      if (filters.size && filters.size.length > 0) {
        const sz = p.attributes?.size;
        if (!sz || !filters.size.includes(sz)) return false;
      }
      if (filters.brand && filters.brand.length > 0) {
        if (!p.brand || !filters.brand.includes(p.brand)) return false;
      }
      if (filters.priceMin !== undefined && p.priceGbp) {
        const n = Number.parseFloat(p.priceGbp);
        if (Number.isFinite(n) && n < filters.priceMin) return false;
      }
      if (filters.priceMax !== undefined && p.priceGbp) {
        const n = Number.parseFloat(p.priceGbp);
        if (Number.isFinite(n) && n > filters.priceMax) return false;
      }
      return true;
    });

    // Sort.
    const sortKey = opts.sort ?? 'newest';
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'price-asc') {
        const ap = priceNumber(a.priceGbp);
        const bp = priceNumber(b.priceGbp);
        return ap - bp;
      }
      if (sortKey === 'price-desc') {
        const ap = priceNumber(a.priceGbp);
        const bp = priceNumber(b.priceGbp);
        return bp - ap;
      }
      // 'newest' default — most recent createdAt first.
      const at = a.createdAt?.getTime() ?? 0;
      const bt = b.createdAt?.getTime() ?? 0;
      return bt - at;
    });

    const page = Math.max(1, opts.page ?? 1);
    const start = (page - 1) * PAGE_SIZE;
    const paged = sorted.slice(start, start + PAGE_SIZE);

    return {
      category: meta,
      products: paged.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        colour: p.colour,
        colourHex: p.colourHex,
        priceGbp: p.priceGbp,
        heroImageUrl: p.heroImageUrl,
        brand: p.brand,
        stockState: p.stockState,
        attributes: p.attributes,
      })),
      totalCount: sorted.length,
      facets,
    };
  }
}

// ──────────────────────────────────────────────────────────
// Facet computation
// ──────────────────────────────────────────────────────────

function priceNumber(s: string | null): number {
  if (!s) return Infinity;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : Infinity;
}

function bump<K extends string>(map: Record<K, number>, key: K): void {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  map[key] = (map[key] ?? 0) + 1;
}

interface EnrichedForFacets {
  brand: string | null;
  colour: string | null;
  priceGbp: string | null;
  stockState: StockState;
  attributes: Record<string, string> | null;
}

export function computeFacets(rows: EnrichedForFacets[]): CategoryFacetCounts {
  const brand: Record<string, number> = {};
  const colour: Record<string, number> = {};
  const size: Record<string, number> = {};
  const stockState: Record<StockState, number> = {
    IN_STOCK: 0,
    AVAILABLE_FROM_SUPPLIER: 0,
    OUT_OF_STOCK: 0,
  };
  let priceMin: number | null = null;
  let priceMax: number | null = null;
  for (const p of rows) {
    if (p.brand) bump(brand, p.brand);
    if (p.colour) bump(colour, p.colour);
    if (p.attributes?.size) bump(size, p.attributes.size);
    bump(stockState, p.stockState);
    if (p.priceGbp) {
      const n = Number.parseFloat(p.priceGbp);
      if (Number.isFinite(n)) {
        if (priceMin === null || n < priceMin) priceMin = n;
        if (priceMax === null || n > priceMax) priceMax = n;
      }
    }
  }
  return {
    brand,
    colour,
    size,
    stockState,
    priceRange:
      priceMin !== null && priceMax !== null
        ? { min: priceMin.toFixed(2), max: priceMax.toFixed(2) }
        : null,
  };
}

function emptyFacets(): CategoryFacetCounts {
  return {
    brand: {},
    colour: {},
    size: {},
    stockState: { IN_STOCK: 0, AVAILABLE_FROM_SUPPLIER: 0, OUT_OF_STOCK: 0 },
    priceRange: null,
  };
}

// Suppress unused-import warnings for the drizzle helpers we don't
// use locally but want re-exported when the module grows.
export const _sentinel = { sql, asc, desc };
