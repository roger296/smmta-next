import { describe, expect, it } from 'vitest';
import type { GroupListItem } from './api-types';
import { materialOfGroup, pickRecommendations } from './recommendations';

function group(
  slug: string,
  name: string,
  opts: { sortOrder: number; qty?: number; price?: string; maxPrice?: string; shortDescription?: string },
): GroupListItem {
  const qty = opts.qty ?? 10;
  return {
    id: `group-${slug}`,
    slug,
    name,
    shortDescription: opts.shortDescription ?? null,
    heroImageUrl: `https://img.example/${slug}.jpg`,
    galleryImageUrls: null,
    seoTitle: null,
    seoDescription: null,
    sortOrder: opts.sortOrder,
    priceRange: { min: opts.price ?? '9.99', max: opts.maxPrice ?? opts.price ?? '9.99' },
    totalAvailableQty: qty,
    variants: [
      {
        id: `variant-${slug}`,
        slug: `${slug}-black`,
        colour: 'Black',
        colourHex: '#000000',
        priceGbp: opts.price ?? '9.99',
        maxPriceGbp: opts.maxPrice ?? null,
        availableQty: qty,
        stockState: qty > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
        heroImageUrl: null,
      },
    ],
  };
}

const PLA_CARBON = 'landau-pla-carbon-fibre-1-75mm-1kg';
const PLA_BASIC = 'landau-pla-basic-1-75mm-1kg';
const PLA_SILK = 'landau-pla-silk-1-75mm-1kg';
const PETG = 'landau-petg-1-75mm-1kg';
const ABS_CARBON = 'landau-abs-carbon-fibre-1-75mm-1kg';
const TPU = 'landau-tpu-95a-1-75mm-1kg';

function catalogue(overrides: { tpuQty?: number } = {}): GroupListItem[] {
  return [
    group(PLA_CARBON, 'Landau PLA Carbon Fibre 1.75mm 1kg', { sortOrder: 1 }),
    group(PLA_BASIC, 'Landau PLA Basic 1.75mm 1kg', { sortOrder: 2 }),
    group(PLA_SILK, 'Landau PLA Silk 1.75mm 1kg', { sortOrder: 3, price: '11.99', maxPrice: '14.99' }),
    group(PETG, 'Landau PETG 1.75mm 1kg', { sortOrder: 4 }),
    group(ABS_CARBON, 'Landau ABS Carbon Fibre 1.75mm 1kg', { sortOrder: 5 }),
    group(TPU, 'Landau TPU 95A 1.75mm 1kg', { sortOrder: 6, qty: overrides.tpuQty }),
  ];
}

const line = (slug: string) => ({ groupId: `group-${slug}`, productName: null });

describe('pickRecommendations', () => {
  it('suggests another range of the material bought, then a neighbouring material', () => {
    const picks = pickRecommendations({ lines: [line(PLA_BASIC)] }, catalogue());
    expect(picks.map((p) => [p.name, p.eyebrow])).toEqual([
      ['Landau PLA Silk 1.75mm 1kg', 'Your next PLA'],
      ['Landau TPU 95A 1.75mm 1kg', 'Try TPU'],
    ]);
    expect(picks[0]).toMatchObject({
      path: `/shop/${PLA_SILK}`,
      imageUrl: `https://img.example/${PLA_SILK}.jpg`,
      // The lowest min price, not the single-spool ceiling of £14.99.
      priceFrom: '£11.99',
      material: 'PLA',
      blurb: 'High-gloss, near-metallic sheen. Prints best slightly hotter and slower.',
    });
    // No volume pricing: the one price is the price.
    expect(picks[1]?.priceFrom).toBe('£9.99');
  });

  it('never suggests a range that was bought, including one named on a line with no group id', () => {
    const picks = pickRecommendations(
      { lines: [line(PLA_BASIC), { groupId: null, productName: 'Landau PLA Silk 1.75mm 1kg — Gold' }] },
      catalogue(),
    );
    expect(picks.map((p) => p.name)).toEqual(['Landau TPU 95A 1.75mm 1kg', 'Landau PETG 1.75mm 1kg']);
  });

  it('prices a range from the lowest min price of its products', () => {
    const silk = group(PLA_SILK, 'Landau PLA Silk 1.75mm 1kg', { sortOrder: 1, price: '13.50', maxPrice: '16.00' });
    silk.variants.push(
      { ...silk.variants[0]!, id: 'variant-silk-gold', priceGbp: '10.25', maxPriceGbp: '15.00', availableQty: 0 },
      { ...silk.variants[0]!, id: 'variant-silk-unpriced', priceGbp: null, maxPriceGbp: null },
    );
    const [pick] = pickRecommendations({ lines: [] }, [silk]);
    expect(pick?.priceFrom).toBe('£10.25');
  });

  it('skips ranges that cannot be bought now', () => {
    const picks = pickRecommendations({ lines: [line(PLA_BASIC)] }, catalogue({ tpuQty: 0 }));
    expect(picks.map((p) => p.name)).toEqual(['Landau PLA Silk 1.75mm 1kg', 'Landau PETG 1.75mm 1kg']);
  });

  it('suggests carbon fibre only to a customer who has bought carbon fibre', () => {
    const withCarbon = pickRecommendations({ lines: [line(PLA_BASIC), line(ABS_CARBON)] }, catalogue());
    expect(withCarbon[0]?.name).toBe('Landau PLA Carbon Fibre 1.75mm 1kg');
    const without = pickRecommendations({ lines: [line(PLA_BASIC)] }, catalogue());
    expect(without.map((p) => p.name)).not.toContain('Landau PLA Carbon Fibre 1.75mm 1kg');
  });

  it('offers two different materials when the order has no recognised material', () => {
    const picks = pickRecommendations({ lines: [{ groupId: 'group-gift-card', productName: 'Gift card' }] }, catalogue());
    expect(picks.map((p) => [p.name, p.eyebrow])).toEqual([
      ['Landau PLA Basic 1.75mm 1kg', 'Try PLA'],
      ['Landau PETG 1.75mm 1kg', 'Try PETG'],
    ]);
  });

  it('returns nothing when nothing can be bought', () => {
    const soldOut = catalogue().map((g) => ({
      ...g,
      totalAvailableQty: 0,
      variants: g.variants.map((v) => ({ ...v, availableQty: 0, stockState: 'OUT_OF_STOCK' as const })),
    }));
    expect(pickRecommendations({ lines: [line(PLA_BASIC)] }, soldOut)).toEqual([]);
  });

  it('uses the description, or the material pitch, for a range without range copy', () => {
    const long = 'A very flexible filament. '.repeat(10);
    const [described] = pickRecommendations(
      { lines: [] },
      [group('new-tpu', 'Acme TPU 85A 1.75mm', { sortOrder: 1, shortDescription: long })],
    );
    expect(described?.blurb.length).toBeLessThanOrEqual(120);
    expect(described?.blurb.endsWith('…')).toBe(true);

    const [bare] = pickRecommendations({ lines: [] }, [group('new-asa', 'Acme ASA 1.75mm', { sortOrder: 1 })]);
    expect(bare?.blurb).toMatch(/outdoors/i);
  });
});

describe('materialOfGroup', () => {
  it('reads the material from range copy, then from the name', () => {
    expect(materialOfGroup({ name: 'Anything', slug: TPU })).toBe('TPU');
    expect(materialOfGroup({ name: 'Polymaker PETG Pro', slug: null })).toBe('PETG');
    expect(materialOfGroup({ name: 'Acme ASA 1.75mm', slug: null })).toBe('ASA');
    expect(materialOfGroup({ name: 'Gift card', slug: null })).toBeNull();
  });
});
