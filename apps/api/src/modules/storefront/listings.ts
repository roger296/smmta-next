/**
 * One listing per range on the Clothes Shop category and search pages.
 *
 * The catalogue holds each size and colour as its own product, linked to its
 * range by `group_id`. Listing every one filled a category with "Eco
 * Sweatshirt · Bottle Green · S", "… · L", "… · 2XL", so the pages show one
 * card per range instead, the way the Filament Store shows one card per
 * filament with its colours. The customer picks colour and size on the range
 * page.
 *
 * Filters still apply to single variants: a range is listed when at least one
 * of its variants matches, and its price is the span of the variants that
 * match. Facet counts count listings, not variants.
 *
 * A product with no range, or whose range has no slug or isn't published (and
 * so has no range page to open), is listed on its own.
 */
import type { StockState } from './availability.js';
import { compareSizes } from './sizes.js';

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
  /** Facet value → number of listings with a variant of that value in the
   *  selected stock states. Worked out before the colour, size, brand and
   *  price filters, so the sidebar shows the whole category. */
  brand: Record<string, number>;
  colour: Record<string, number>;
  size: Record<string, number>;
  /** Listings with a variant in each state, whatever the stock filter. */
  stockState: Record<StockState, number>;
  /** Cheapest and dearest variant in the selected stock states. */
  priceRange: { min: string; max: string } | null;
}

export interface ListingGroup {
  id: string;
  slug: string | null;
  name: string;
  heroImageUrl: string | null;
  /** Published and not deleted, so its range page opens. */
  isPublished: boolean;
}

/** A variant offered on the channel, as the builder reads it. */
export interface ListingVariant {
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
  group: ListingGroup | null;
}

export interface ListingColour {
  name: string;
  hex: string | null;
}

export interface CategoryListing {
  /** The range's group id, or the product id for a product listed on its own. */
  id: string;
  /** `range` opens /shop/<slug>, where colour and size are picked;
   *  `product` opens /shop/p/<slug>. */
  kind: 'range' | 'product';
  slug: string | null;
  name: string;
  /** Cheapest and dearest of the variants that match the filters. */
  priceMinGbp: string | null;
  priceMaxGbp: string | null;
  heroImageUrl: string | null;
  /** The best stock state among the variants that match. */
  stockState: StockState;
  /** Every colour and size the range has in the selected stock states — a
   *  card filtered to Black still shows the other colours. Sizes are in size
   *  order, colours alphabetical. */
  colours: ListingColour[];
  sizes: string[];
  brand: string | null;
}

export const DEFAULT_STOCK_STATES: StockState[] = ['IN_STOCK', 'AVAILABLE_FROM_SUPPLIER'];

const STOCK_RANK: Record<StockState, number> = {
  OUT_OF_STOCK: 0,
  AVAILABLE_FROM_SUPPLIER: 1,
  IN_STOCK: 2,
};

function hasRangePage(group: ListingGroup | null): group is ListingGroup {
  return group !== null && group.isPublished && Boolean(group.slug);
}

/** Which listing a variant belongs to. */
export function listingKey(v: ListingVariant): string {
  return hasRangePage(v.group) ? `range:${v.group.id}` : `product:${v.id}`;
}

/**
 * Group variants into listings, filter, count facets and sort. Paging is the
 * caller's: slice `listings`.
 */
export function buildListings(
  variants: ListingVariant[],
  opts: { filters?: CategoryFilters; sort?: SortKey } = {},
): { listings: CategoryListing[]; facets: CategoryFacetCounts } {
  const filters = opts.filters ?? {};
  const stockFilter = filters.stockState ?? DEFAULT_STOCK_STATES;

  const units = new Map<string, ListingVariant[]>();
  for (const v of variants) {
    const key = listingKey(v);
    const unit = units.get(key);
    if (unit) unit.push(v);
    else units.set(key, [v]);
  }

  const facets = emptyFacets();
  let priceMin: number | null = null;
  let priceMax: number | null = null;
  const built: Array<{ listing: CategoryListing; newest: number }> = [];

  for (const unit of units.values()) {
    for (const state of new Set(unit.map((v) => v.stockState))) facets.stockState[state] += 1;

    const shown = unit.filter((v) => stockFilter.includes(v.stockState));
    bumpEach(facets.brand, shown.map((v) => v.brand));
    bumpEach(facets.colour, shown.map((v) => v.colour));
    bumpEach(facets.size, shown.map((v) => v.attributes?.size));
    for (const v of shown) {
      const n = parsePrice(v.priceGbp);
      if (n === null) continue;
      if (priceMin === null || n < priceMin) priceMin = n;
      if (priceMax === null || n > priceMax) priceMax = n;
    }

    const matching = shown.filter((v) => matchesFilters(v, filters));
    if (matching.length === 0) continue;
    const newest = Math.max(...matching.map((v) => v.createdAt?.getTime() ?? 0));
    built.push({ listing: toListing(shown, matching, filters), newest });
  }

  if (priceMin !== null && priceMax !== null) {
    facets.priceRange = { min: priceMin.toFixed(2), max: priceMax.toFixed(2) };
  }

  const sort = opts.sort ?? 'newest';
  built.sort((a, b) => {
    let order: number;
    if (sort === 'price-asc') {
      order = comparePrices(parsePrice(a.listing.priceMinGbp), parsePrice(b.listing.priceMinGbp), 1);
    } else if (sort === 'price-desc') {
      order = comparePrices(parsePrice(a.listing.priceMaxGbp), parsePrice(b.listing.priceMaxGbp), -1);
    } else {
      order = b.newest - a.newest;
    }
    return order || a.listing.name.localeCompare(b.listing.name);
  });

  return { listings: built.map((b) => b.listing), facets };
}

export function emptyFacets(): CategoryFacetCounts {
  return {
    brand: {},
    colour: {},
    size: {},
    stockState: { IN_STOCK: 0, AVAILABLE_FROM_SUPPLIER: 0, OUT_OF_STOCK: 0 },
    priceRange: null,
  };
}

function toListing(
  shown: ListingVariant[],
  matching: ListingVariant[],
  filters: CategoryFilters,
): CategoryListing {
  const first = matching[0]!;
  const group = hasRangePage(first.group) ? first.group : null;

  let min: { text: string; n: number } | null = null;
  let max: { text: string; n: number } | null = null;
  let stockState: StockState = 'OUT_OF_STOCK';
  for (const v of matching) {
    const n = parsePrice(v.priceGbp);
    if (n !== null) {
      if (!min || n < min.n) min = { text: v.priceGbp!, n };
      if (!max || n > max.n) max = { text: v.priceGbp!, n };
    }
    if (STOCK_RANK[v.stockState] > STOCK_RANK[stockState]) stockState = v.stockState;
  }

  // Filtered to a colour, show that colour; otherwise the range's own picture.
  const variantImage = matching.find((v) => v.heroImageUrl)?.heroImageUrl ?? null;
  const heroImageUrl =
    filters.colour && filters.colour.length > 0
      ? variantImage ?? group?.heroImageUrl ?? null
      : group?.heroImageUrl ?? variantImage;

  const colours = new Map<string, string | null>();
  const sizes = new Set<string>();
  for (const v of shown) {
    if (v.colour && (!colours.has(v.colour) || (!colours.get(v.colour) && v.colourHex))) {
      colours.set(v.colour, v.colourHex);
    }
    const size = v.attributes?.size;
    if (size) sizes.add(size);
  }

  return {
    id: group ? group.id : first.id,
    kind: group ? 'range' : 'product',
    slug: group ? group.slug : first.slug,
    name: group ? group.name : first.name,
    priceMinGbp: min?.text ?? null,
    priceMaxGbp: max?.text ?? null,
    heroImageUrl,
    stockState,
    colours: [...colours]
      .map(([name, hex]) => ({ name, hex }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sizes: [...sizes].sort(compareSizes),
    brand: matching.find((v) => v.brand)?.brand ?? null,
  };
}

function matchesFilters(v: ListingVariant, f: CategoryFilters): boolean {
  if (f.colour && f.colour.length > 0 && (!v.colour || !f.colour.includes(v.colour))) return false;
  if (f.size && f.size.length > 0) {
    const size = v.attributes?.size;
    if (!size || !f.size.includes(size)) return false;
  }
  if (f.brand && f.brand.length > 0 && (!v.brand || !f.brand.includes(v.brand))) return false;
  const price = parsePrice(v.priceGbp);
  if (price !== null) {
    if (f.priceMin !== undefined && price < f.priceMin) return false;
    if (f.priceMax !== undefined && price > f.priceMax) return false;
  }
  return true;
}

function parsePrice(s: string | null): number | null {
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Unpriced listings go last whichever way the prices run. */
function comparePrices(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
  return (a - b) * direction;
}

/** Count each distinct value once. */
function bumpEach(map: Record<string, number>, values: Array<string | null | undefined>): void {
  for (const value of new Set(values)) {
    if (value) map[value] = (map[value] ?? 0) + 1;
  }
}
