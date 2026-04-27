/**
 * Storefront response types — hand-rolled to mirror SMMTA-NEXT's
 * `CatalogueService` shapes from Prompt 4. The `gen:api-types` script
 * writes the path-based OpenAPI types to `lib/openapi-spec.ts` for
 * cross-reference; consumers import from this file because the API
 * spec emits no named schemas.
 *
 * If the API response shape changes (new fields, removed fields), update
 * the matching interface here by hand. The tests in `lib/smmta.test.ts`
 * pin a representative subset of the shape so a divergence shows up.
 */

export interface ThinVariant {
  id: string;
  slug: string | null;
  colour: string | null;
  colourHex: string | null;
  /** Decimal string in major units (e.g. "24.00"). */
  priceGbp: string | null;
  availableQty: number;
  heroImageUrl: string | null;
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

export interface PriceRange {
  min: string;
  max: string;
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
  priceRange: PriceRange | null;
  totalAvailableQty: number;
  variants: ThinVariant[];
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

/** Canonical envelope for every storefront read response. */
export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}
