/**
 * Structured-data builders. Single source of truth for every JSON-LD
 * shape the storefront emits — Organization (sitewide), WebSite +
 * SearchAction (sitewide), BreadcrumbList (every shop page), Product +
 * Offer / AggregateOffer (group + product detail pages), and FAQPage
 * (the shipping/returns FAQ block).
 *
 * Each helper returns a plain JS object that callers stringify into a
 * `<script type="application/ld+json">` tag. Keeping the structure out
 * of JSX lets us unit-test it without a render harness.
 */
import type { FullGroup, FullProduct, GroupListItem, ThinVariant } from '../api-types';

export const ORG_NAME = 'Filament Store';

// ---------------------------------------------------------------------------
// Sitewide
// ---------------------------------------------------------------------------

export function organizationLd(baseUrl: URL): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: ORG_NAME,
    url: baseUrl.toString(),
  };
}

export function websiteLd(baseUrl: URL): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: ORG_NAME,
    url: baseUrl.toString(),
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${baseUrl.toString().replace(/\/$/, '')}/shop?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

// ---------------------------------------------------------------------------
// BreadcrumbList — used on every shop page
// ---------------------------------------------------------------------------

export interface BreadcrumbCrumb {
  name: string;
  url: string;
}

export function breadcrumbLd(baseUrl: URL, crumbs: BreadcrumbCrumb[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: c.name,
      item: new URL(c.url, baseUrl).toString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Product / Offer / AggregateOffer
// ---------------------------------------------------------------------------

/** Single Product + Offer JSON-LD. Used on the standalone product page and
 *  on a group page once a colour is selected. */
export function productLd(
  baseUrl: URL,
  product: {
    name: string;
    slug: string | null;
    colour: string | null;
    priceGbp: string | null;
    availableQty: number;
    heroImageUrl: string | null;
    seoDescription: string | null;
    shortDescription: string | null;
  },
  url: string,
): Record<string, unknown> {
  const offer: Record<string, unknown> = {
    '@type': 'Offer',
    url: new URL(url, baseUrl).toString(),
    priceCurrency: 'GBP',
    availability:
      product.availableQty > 0
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
  };
  if (product.priceGbp !== null) offer.price = product.priceGbp;

  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.seoDescription ?? product.shortDescription ?? undefined,
    sku: product.slug ?? undefined,
    color: product.colour ?? undefined,
    image: product.heroImageUrl ?? undefined,
    offers: offer,
  };
  // Strip `undefined` values to keep the JSON-LD lean.
  return prune(ld);
}

/** Group page JSON-LD: Product + AggregateOffer summarising published variants. */
export function groupProductLd(
  baseUrl: URL,
  group: FullGroup,
  url: string,
): Record<string, unknown> {
  const variants = group.variants;
  const prices = variants
    .map((v) => (v.priceGbp ? Number.parseFloat(v.priceGbp) : null))
    .filter((p): p is number => p !== null && Number.isFinite(p));
  const totalAvailable = variants.reduce((s, v) => s + v.availableQty, 0);

  const offers: Record<string, unknown> | undefined =
    prices.length > 0
      ? {
          '@type': 'AggregateOffer',
          priceCurrency: 'GBP',
          lowPrice: Math.min(...prices).toFixed(2),
          highPrice: Math.max(...prices).toFixed(2),
          offerCount: variants.length,
          availability:
            totalAvailable > 0
              ? 'https://schema.org/InStock'
              : 'https://schema.org/OutOfStock',
        }
      : undefined;

  return prune({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: group.name,
    description: group.seoDescription ?? group.shortDescription ?? undefined,
    sku: group.slug ?? undefined,
    image: group.heroImageUrl ?? undefined,
    offers,
  });
}

// ---------------------------------------------------------------------------
// FAQPage — the shipping / returns FAQ block on group pages
// ---------------------------------------------------------------------------

export interface FaqEntry {
  question: string;
  answer: string;
}

export function faqPageLd(entries: FaqEntry[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries.map((e) => ({
      '@type': 'Question',
      name: e.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: e.answer,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively remove `undefined` and empty-string fields from a JSON-LD object
 *  so the emitted markup stays small and Google validators don't whine. */
function prune<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      out[k] = v;
    } else if (typeof v === 'object') {
      out[k] = prune(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Helper for the catalogue page — picks a representative price-from from a
 *  list of group/standalone cards. Pure enough to unit-test. */
export function priceFrom(items: Array<GroupListItem | { variants: ThinVariant[] }>): {
  min: number;
  max: number;
} | null {
  const allPrices: number[] = [];
  for (const it of items) {
    for (const v of it.variants) {
      if (v.priceGbp) {
        const n = Number.parseFloat(v.priceGbp);
        if (Number.isFinite(n)) allPrices.push(n);
      }
    }
  }
  if (allPrices.length === 0) return null;
  return { min: Math.min(...allPrices), max: Math.max(...allPrices) };
}

/** Render a price-from string for a single group / standalone product. */
export function priceFromString(group: { priceRange: { min: string; max: string } | null }): string | null {
  if (!group.priceRange) return null;
  if (group.priceRange.min === group.priceRange.max) return `£${group.priceRange.min}`;
  return `£${group.priceRange.min} – £${group.priceRange.max}`;
}

/** Stringify a JSON-LD object for inclusion in a `<script>` tag. We escape
 *  `</script>` to prevent injection from any malicious content (description /
 *  product names come from the operator-controlled CMS, but defence in depth). */
export function stringifyJsonLd(obj: Record<string, unknown>): string {
  return JSON.stringify(obj).replaceAll('</', '<\\/');
}
