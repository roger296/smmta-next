/**
 * Variant-picking helpers shared between the PDP page (server component)
 * and the swatch picker (client component).
 *
 * `pickDefaultVariant` chooses the variant to show first when no explicit
 * `?colour=` is on the URL. We prefer the first in-stock variant —
 * defaulting to an out-of-stock SKU when buyable colours exist makes the
 * catalogue look thinner than it is and pushes the customer toward a
 * notify-me flow they'd skip if shown a buyable product. Falls back to
 * `variants[0]` only when every variant is out of stock.
 *
 * Tiebreaker: input order. Callers are expected to pass variants already
 * sorted by `sortOrderInGroup` / colour name (which is what the API
 * does). The helper does not re-sort.
 */
import { effectiveStockState, isSellable } from './dispatch-copy';
import type { StockState } from './api-types';

export interface PickableVariant {
  id: string;
  colour: string | null;
  availableQty: number;
  stockState?: StockState;
}

/**
 * Default-variant preference, in order:
 *   1. First variant with `stockState === 'IN_STOCK'` (warehouse-fulfilled,
 *      ships within 1 day — shortest path to a buyable product).
 *   2. First variant with `stockState === 'AVAILABLE_FROM_SUPPLIER'`
 *      (drop-ship, 2 working days).
 *   3. Alphabetical / input-order fallback when every variant is OOS.
 */
export function pickDefaultVariant<T extends PickableVariant>(variants: T[]): T | undefined {
  if (variants.length === 0) return undefined;
  const inStock = variants.find((v) => effectiveStockState(v) === 'IN_STOCK');
  if (inStock) return inStock;
  const supplier = variants.find((v) => effectiveStockState(v) === 'AVAILABLE_FROM_SUPPLIER');
  if (supplier) return supplier;
  return variants[0];
}

/**
 * Resolve the variant the page should render given an optional `?colour=`
 * query value. Explicit colour matches take precedence — if the customer
 * deep-linked to a specific SKU, we honour their request even if it's out
 * of stock. Only the no-colour path uses the in-stock-default behaviour.
 */
export function resolveInitialVariant<T extends PickableVariant>(
  variants: T[],
  queriedColour: string | null | undefined,
): T | undefined {
  if (queriedColour) {
    const requested = variants.find(
      (v) => v.colour && v.colour.toLowerCase() === queriedColour.toLowerCase(),
    );
    if (requested) return requested;
  }
  return pickDefaultVariant(variants);
}

/**
 * The price a customer pays for ONE of this variant — the top of the band a
 * catalogue card advertises.
 *
 * Volume pricing means a variant has two prices: the floor (`priceGbp`, the
 * 10+ rate) and the ceiling (`maxPriceGbp`, a single unit). The price filter
 * works on this figure so that it matches the upper number on the card. Using
 * the floor left the slider's whole upper half inert, because its bound was
 * derived from floors while cards advertised ceilings roughly twice as high.
 *
 * Falls back to the floor for a variant that does not slide, since that is
 * then the only price it has.
 */
export function variantCeilingGbp(v: {
  priceGbp: string | null;
  maxPriceGbp?: string | null;
}): number | null {
  const raw = v.maxPriceGbp ?? v.priceGbp;
  if (raw == null) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** The lowest price a variant can reach (the volume rate). */
export function variantFloorGbp(v: { priceGbp: string | null }): number | null {
  if (v.priceGbp == null) return null;
  const n = Number.parseFloat(v.priceGbp);
  return Number.isFinite(n) ? n : null;
}

export interface ColourLink {
  colour: string;
  /** Null only when neither the variant nor its group has a slug to link to. */
  href: string | null;
  /** Buyable now, from the warehouse or the supplier. */
  inStock: boolean;
}

/**
 * The colours a group card lists beneath it, each linked to its own page.
 *
 * Lists every published colour, in stock or not: a customer looking for a
 * particular colour should learn the range carries it even when it is sold
 * out, rather than conclude it does not exist. Links go to the variant's own
 * /shop/p/ page, which is indexable and self-canonical, so each one is also a
 * crawlable path to a page that ranks for "<colour> <material> filament".
 *
 * Falls back to the group page's ?colour= toggle for a variant with no slug,
 * matching what the card itself does.
 */
export function colourLinks(group: {
  slug: string | null;
  variants: Array<{
    slug: string | null;
    colour: string | null;
    stockState?: StockState;
    availableQty?: number;
  }>;
}): ColourLink[] {
  const byColour = new Map<string, ColourLink>();
  for (const v of group.variants) {
    const colour = v.colour?.trim();
    if (!colour) continue;
    const inStock = isSellable(effectiveStockState(v));
    const key = colour.toLowerCase();
    const existing = byColour.get(key);
    if (existing) {
      // Two variants sharing a colour: in stock if either is, and prefer a
      // real product page over the group-toggle fallback.
      existing.inStock = existing.inStock || inStock;
      if (!existing.href?.startsWith('/shop/p/') && v.slug) existing.href = `/shop/p/${v.slug}`;
      continue;
    }
    const href = v.slug
      ? `/shop/p/${v.slug}`
      : group.slug
        ? `/shop/${group.slug}?colour=${encodeURIComponent(colour)}`
        : null;
    byColour.set(key, { colour, href, inStock });
  }
  return Array.from(byColour.values());
}
