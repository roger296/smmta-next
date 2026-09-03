/**
 * Unit tests for the structured-data builders. Pure functions, no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  breadcrumbLd,
  faqPageLd,
  groupProductLd,
  organizationLd,
  priceFrom,
  priceFromString,
  productLd,
  stringifyJsonLd,
  websiteLd,
} from './structured-data';
import type { FullGroup, FullVariant } from '../api-types';

const BASE = new URL('https://example.com/');

describe('organizationLd', () => {
  it('emits the @context and Organization @type', () => {
    const ld = organizationLd(BASE);
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('Organization');
    expect(ld.url).toBe('https://example.com/');
    expect(ld.name).toBe('Filament Store');
  });
});

describe('websiteLd', () => {
  it('emits a SearchAction action pointing at /shop?q=', () => {
    const ld = websiteLd(BASE) as {
      potentialAction: { target: { urlTemplate: string }; 'query-input': string };
    };
    expect(ld.potentialAction.target.urlTemplate).toBe(
      'https://example.com/shop?q={search_term_string}',
    );
    expect(ld.potentialAction['query-input']).toBe('required name=search_term_string');
  });
});

describe('breadcrumbLd', () => {
  it('emits ListItem entries with absolute URLs and 1-based positions', () => {
    const ld = breadcrumbLd(BASE, [
      { name: 'Home', url: '/' },
      { name: 'Shop', url: '/shop' },
      { name: 'Aurora Range', url: '/shop/aurora-range' },
    ]) as {
      itemListElement: Array<{ position: number; name: string; item: string }>;
    };
    expect(ld.itemListElement).toHaveLength(3);
    expect(ld.itemListElement[0]).toMatchObject({
      position: 1,
      name: 'Home',
      item: 'https://example.com/',
    });
    expect(ld.itemListElement[2]).toMatchObject({
      position: 3,
      name: 'Aurora Range',
      item: 'https://example.com/shop/aurora-range',
    });
  });
});

const VARIANT: FullVariant = {
  id: 'v-1',
  slug: 'aurora-smoke',
  colour: 'Smoke',
  colourHex: '#3a3a3a',
  priceGbp: '24.00',
  availableQty: 5,
  heroImageUrl: 'https://cdn.example.com/aurora-smoke.jpg',
  name: 'Aurora — Smoke',
  shortDescription: 'A short tagline.',
  longDescription: 'Long copy.',
  galleryImageUrls: null,
  seoTitle: null,
  seoDescription: 'A designer LED filament lamp.',
  seoKeywords: null,
  sortOrderInGroup: 0,
};

describe('productLd', () => {
  it('marks InStock when availableQty > 0 and includes Offer.price', () => {
    const ld = productLd(BASE, VARIANT, '/shop/p/aurora-smoke') as {
      offers: { availability: string; price: string; priceCurrency: string; url: string };
      sku: string;
      color: string;
    };
    expect(ld.offers.availability).toBe('https://schema.org/InStock');
    expect(ld.offers.price).toBe('24.00');
    expect(ld.offers.priceCurrency).toBe('GBP');
    expect(ld.offers.url).toBe('https://example.com/shop/p/aurora-smoke');
    expect(ld.sku).toBe('aurora-smoke');
    expect(ld.color).toBe('Smoke');
  });

  it('marks OutOfStock when availableQty is 0', () => {
    const ld = productLd(BASE, { ...VARIANT, availableQty: 0 }, '/x') as {
      offers: { availability: string };
    };
    expect(ld.offers.availability).toBe('https://schema.org/OutOfStock');
  });

  it('omits price when priceGbp is null', () => {
    const ld = productLd(BASE, { ...VARIANT, priceGbp: null }, '/x') as {
      offers: { price?: string };
    };
    expect(ld.offers.price).toBeUndefined();
  });
});

describe('groupProductLd', () => {
  const GROUP: FullGroup = {
    id: 'g-1',
    slug: 'aurora-range',
    name: 'Aurora Range',
    shortDescription: 'A short tagline.',
    longDescription: null,
    heroImageUrl: 'https://cdn.example.com/g.jpg',
    galleryImageUrls: null,
    seoTitle: null,
    seoDescription: 'Designer LED filament lamps.',
    seoKeywords: null,
    sortOrder: 0,
    priceRange: { min: '24.00', max: '34.00' },
    totalAvailableQty: 7,
    variants: [
      VARIANT,
      { ...VARIANT, id: 'v-2', slug: 'aurora-amber', colour: 'Amber', priceGbp: '34.00', availableQty: 2 },
    ],
  };

  it('emits a ProductGroup whose variants carry their own price and availability', () => {
    // Replaces the old AggregateOffer assertion. AggregateOffer reported
    // one availability for the whole range, so a group with four of five
    // colours sold out still advertised "InStock" — true of one variant
    // and misleading to everyone who clicked for a different colour.
    // ProductGroup is Google's pattern for per-variant accuracy.
    const ld = groupProductLd(BASE, GROUP, '/shop/aurora-range') as {
      '@type': string;
      variesBy: string[];
      hasVariant: Array<{
        '@type': string;
        color?: string;
        offers: { price?: string; availability: string };
      }>;
    };
    expect(ld['@type']).toBe('ProductGroup');
    expect(ld.variesBy).toContain('https://schema.org/color');
    expect(ld.hasVariant).toHaveLength(2);

    const prices = ld.hasVariant.map((v) => v.offers.price).sort();
    expect(prices).toEqual(['24.00', '34.00']);

    // Every variant carries its own availability rather than inheriting
    // a single group-level flag.
    for (const variant of ld.hasVariant) {
      expect(variant['@type']).toBe('Product');
      expect(variant.offers.availability).toMatch(/schema\.org\/(InStock|OutOfStock|BackOrder)/);
    }
  });

  it('marks up the return policy and shipping on every offer', () => {
    // Both are recommended merchant-listing properties, and both are
    // facts we already publish — a 28-day sealed-goods window and a flat
    // £4.95 rate. Free enhancement for a brand with no ratings yet.
    const ld = groupProductLd(BASE, GROUP, '/shop/aurora-range') as {
      hasVariant: Array<{
        offers: {
          hasMerchantReturnPolicy: { merchantReturnDays: number };
          shippingDetails: { shippingRate: { value: string } };
          itemCondition: string;
        };
      }>;
    };
    const offer = ld.hasVariant[0]!.offers;
    expect(offer.hasMerchantReturnPolicy.merchantReturnDays).toBe(28);
    expect(offer.shippingDetails.shippingRate.value).toBe('4.95');
    expect(offer.itemCondition).toBe('https://schema.org/NewCondition');
  });

  it('omits offers entirely when no variant has a price', () => {
    const ld = groupProductLd(
      BASE,
      { ...GROUP, variants: [{ ...VARIANT, priceGbp: null }] },
      '/x',
    ) as { offers?: unknown };
    expect(ld.offers).toBeUndefined();
  });
});

describe('faqPageLd', () => {
  it('emits Question/Answer entries in order', () => {
    const ld = faqPageLd([
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ]) as { mainEntity: Array<{ '@type': string; name: string; acceptedAnswer: { text: string } }> };
    expect(ld.mainEntity).toHaveLength(2);
    expect(ld.mainEntity[0]?.name).toBe('Q1');
    expect(ld.mainEntity[0]?.acceptedAnswer.text).toBe('A1');
  });
});

describe('priceFrom + priceFromString', () => {
  it('priceFrom returns null on empty input', () => {
    expect(priceFrom([])).toBeNull();
  });

  it('priceFromString collapses min===max into a single price', () => {
    expect(priceFromString({ priceRange: { min: '18.00', max: '18.00' } })).toBe('£18.00');
    expect(priceFromString({ priceRange: { min: '18.00', max: '24.00' } })).toBe('£18.00 – £24.00');
    expect(priceFromString({ priceRange: null })).toBeNull();
  });
});

describe('stringifyJsonLd', () => {
  it('escapes </script> sequences for safety', () => {
    const json = stringifyJsonLd({ name: 'evil </script><script>alert(1)</script>' });
    expect(json).not.toContain('</script>');
    expect(json).toContain('<\\/script>');
  });
});
