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
/**
 * The brand every product carries. Kept here rather than inlined so a
 * second supplier's ranges can be branded correctly by passing it in.
 */
const DEFAULT_BRAND = 'Landau';

/**
 * Merchant return policy, from the published returns policy.
 *
 * Google treats this as a recommended property for merchant listings,
 * and unlike reviews or GTINs we already have the facts: a 28-day
 * window on unopened goods, with the customer paying return postage.
 * Declaring it costs nothing and is one of the few enhancements
 * available to a brand with no ratings yet.
 */
function returnPolicyLd(baseUrl: URL): Record<string, unknown> {
  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'GB',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: 28,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/ReturnShippingFees',
    merchantReturnLink: new URL('/legal/returns', baseUrl).toString(),
  };
}

/**
 * Shipping details, matching the single delivery proposition used in
 * the page copy. If the flat rate or the dispatch window ever changes,
 * this and the FAQ have to move together — a snippet that promises
 * something checkout doesn't honour is a consumer-protection problem,
 * not just an SEO one.
 */
function shippingDetailsLd(): Record<string, unknown> {
  return {
    '@type': 'OfferShippingDetails',
    shippingRate: {
      '@type': 'MonetaryAmount',
      value: '4.95',
      currency: 'GBP',
    },
    shippingDestination: {
      '@type': 'DefinedRegion',
      addressCountry: 'GB',
    },
    deliveryTime: {
      '@type': 'ShippingDeliveryTime',
      handlingTime: {
        '@type': 'QuantitativeValue',
        minValue: 0,
        maxValue: 1,
        unitCode: 'DAY',
      },
      transitTime: {
        '@type': 'QuantitativeValue',
        minValue: 1,
        maxValue: 2,
        unitCode: 'DAY',
      },
    },
  };
}

/** Map our three-state stock model onto schema.org availability. */
function availabilityFor(stockState: string | undefined, availableQty: number): string {
  if (stockState === 'IN_STOCK') return 'https://schema.org/InStock';
  // A dropship line the supplier holds is genuinely orderable, and
  // BackOrder is the honest term for it — InStock would overstate and
  // OutOfStock would lose the sale.
  if (stockState === 'AVAILABLE_FROM_SUPPLIER') return 'https://schema.org/BackOrder';
  if (stockState === 'OUT_OF_STOCK') return 'https://schema.org/OutOfStock';
  return availableQty > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
}

export function productLd(
  baseUrl: URL,
  product: {
    name: string;
    slug: string | null;
    colour: string | null;
    priceGbp: string | null;
    availableQty: number;
    stockState?: string;
    heroImageUrl: string | null;
    seoDescription: string | null;
    shortDescription: string | null;
  },
  url: string,
): Record<string, unknown> {
  const absoluteUrl = new URL(url, baseUrl).toString();
  const offer: Record<string, unknown> = {
    '@type': 'Offer',
    url: absoluteUrl,
    priceCurrency: 'GBP',
    availability: availabilityFor(product.stockState, product.availableQty),
    itemCondition: 'https://schema.org/NewCondition',
    hasMerchantReturnPolicy: returnPolicyLd(baseUrl),
    shippingDetails: shippingDetailsLd(),
  };
  if (product.priceGbp !== null) offer.price = product.priceGbp;

  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.seoDescription ?? product.shortDescription ?? undefined,
    sku: product.slug ?? undefined,
    // `brand` was missing while the page already printed "Landau" in its
    // eyebrow text — one of several recommended properties Google uses
    // to decide between a bare listing and an enhanced one.
    brand: { '@type': 'Brand', name: DEFAULT_BRAND },
    url: absoluteUrl,
    color: product.colour ?? undefined,
    image: product.heroImageUrl ?? undefined,
    offers: offer,
  };
  // Strip `undefined` values to keep the JSON-LD lean.
  return prune(ld);
}

/** Group page JSON-LD: Product + AggregateOffer summarising published variants. */
/**
 * Group-level structured data as a ProductGroup with hasVariant.
 *
 * Previously a single Product carrying an AggregateOffer, which said
 * `offerCount: 5, availability: InStock` on a range where four of the
 * five colours were out of stock. Not technically false — one variant
 * was buyable — but a shopper arriving from that listing has been
 * misled about the colour they clicked for.
 *
 * ProductGroup is Google's purpose-built pattern for exactly this: each
 * variant carries its OWN price and availability, and `variesBy` tells
 * the crawler which axis distinguishes them. It pairs with variant
 * pages being indexable — the child page carries the Product, this
 * carries the group.
 */
export function groupProductLd(
  baseUrl: URL,
  group: FullGroup,
  url: string,
): Record<string, unknown> {
  const variants = group.variants;
  const absoluteUrl = new URL(url, baseUrl).toString();

  const hasVariant = variants.map((v) => {
    const variantUrl = v.slug
      ? new URL(`/shop/p/${v.slug}`, baseUrl).toString()
      : absoluteUrl;
    const offer: Record<string, unknown> = {
      '@type': 'Offer',
      url: variantUrl,
      priceCurrency: 'GBP',
      availability: availabilityFor(v.stockState, v.availableQty),
      itemCondition: 'https://schema.org/NewCondition',
      hasMerchantReturnPolicy: returnPolicyLd(baseUrl),
      shippingDetails: shippingDetailsLd(),
    };
    if (v.priceGbp) offer.price = v.priceGbp;
    return prune({
      '@type': 'Product',
      name: v.colour ? `${group.name} — ${v.colour}` : group.name,
      sku: v.slug ?? undefined,
      color: v.colour ?? undefined,
      image: v.heroImageUrl ?? group.heroImageUrl ?? undefined,
      url: variantUrl,
      offers: offer,
    });
  });

  return prune({
    '@context': 'https://schema.org',
    '@type': 'ProductGroup',
    name: group.name,
    description: group.seoDescription ?? group.shortDescription ?? undefined,
    productGroupID: group.slug ?? undefined,
    brand: { '@type': 'Brand', name: DEFAULT_BRAND },
    url: absoluteUrl,
    image: group.heroImageUrl ?? undefined,
    // The axis that distinguishes the children. Filament varies by
    // colour only; a clothing store would pass size here too.
    variesBy: ['https://schema.org/color'],
    hasVariant: hasVariant.length > 0 ? hasVariant : undefined,
  });
}

/**
 * ItemList for a listing page.
 *
 * /shop and the material category pages describe a collection and said
 * nothing about what was in it. An ItemList of the products in view is
 * the standard way to tell a crawler what a listing page lists.
 */
export function itemListLd(
  baseUrl: URL,
  items: Array<{ name: string; url: string }>,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    numberOfItems: items.length,
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      url: new URL(item.url, baseUrl).toString(),
    })),
  };
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
