/**
 * Wording and links for a listing card on the category and search pages.
 *
 * A listing is a whole range (every size and colour) or, for a product with
 * no range page, the product alone. See `CategoryListing` in `lib/smmta.ts`.
 */
import type { CategoryListing } from './smmta';
import { letterSizeValue } from './sizes';

/**
 * Where the card goes. A range opens its range page; when the customer has
 * filtered to exactly one colour or size the range has, the page opens on it
 * (`?colour=` / `?size=`, which the picker reads).
 */
export function listingHref(
  listing: Pick<CategoryListing, 'kind' | 'slug' | 'colours' | 'sizes'>,
  chosen: { colour?: string[] | null; size?: string[] | null } = {},
): string {
  if (!listing.slug) return '/shop';
  if (listing.kind === 'product') return `/shop/p/${listing.slug}`;
  const params = new URLSearchParams();
  const colour = onlyOne(chosen.colour);
  if (colour && listing.colours.some((c) => c.name === colour)) params.set('colour', colour);
  const size = onlyOne(chosen.size);
  if (size && listing.sizes.includes(size)) params.set('size', size);
  const qs = params.toString();
  return `/shop/${listing.slug}${qs ? `?${qs}` : ''}`;
}

/** "£8.98" when every matching variant costs the same, else "From £8.98". */
export function priceLabel(listing: Pick<CategoryListing, 'priceMinGbp' | 'priceMaxGbp'>): string | null {
  const { priceMinGbp: min, priceMaxGbp: max } = listing;
  if (!min) return null;
  if (!max || Number(min) === Number(max)) return `£${min}`;
  return `From £${min}`;
}

/** "Sizes XS – 5XL" when the range runs between letter sizes; otherwise a
 *  count, since ages and waist sizes make a poor span ("3/4 – 30R"). */
export function sizeSummary(sizes: string[]): string | null {
  if (sizes.length === 0) return null;
  if (sizes.length === 1) return `Size ${sizes[0]}`;
  const first = sizes[0]!;
  const last = sizes[sizes.length - 1]!;
  if (letterSizeValue(first) !== null && letterSizeValue(last) !== null) {
    return `Sizes ${first} – ${last}`;
  }
  return `${sizes.length} sizes`;
}

/** "Black" for one colour, "12 colours" for several. */
export function colourSummary(colours: CategoryListing['colours']): string | null {
  if (colours.length === 0) return null;
  if (colours.length === 1) return colours[0]!.name;
  return `${colours.length} colours`;
}

/** A hex colour safe to paint a swatch with, or null. */
export function swatchColour(hex: string | null): string | null {
  return hex && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex) ? hex : null;
}

function onlyOne(values: string[] | null | undefined): string | null {
  return values && values.length === 1 ? values[0]! : null;
}
