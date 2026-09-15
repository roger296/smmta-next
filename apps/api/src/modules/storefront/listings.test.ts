import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildListings,
  listingKey,
  type ListingGroup,
  type ListingVariant,
} from './listings.js';

const range = (slug: string, extra: Partial<ListingGroup> = {}): ListingGroup => ({
  id: `group-${slug}`,
  slug,
  name: `Range ${slug}`,
  heroImageUrl: null,
  isPublished: true,
  ...extra,
});

let n = 0;
beforeEach(() => {
  n = 0;
});

const variant = (
  group: ListingGroup | null,
  colour: string,
  size: string,
  extra: Partial<ListingVariant> = {},
): ListingVariant => {
  n += 1;
  return {
    id: `v${n}`,
    slug: `v${n}`,
    name: `${group?.name ?? 'Loose'} · ${colour} · ${size}`,
    colour,
    colourHex: null,
    priceGbp: '10.00',
    heroImageUrl: null,
    attributes: { size, colour },
    brand: null,
    stockState: 'AVAILABLE_FROM_SUPPLIER',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    group,
    ...extra,
  };
};

describe('buildListings', () => {
  it('lists every size and colour of a range as one listing', () => {
    const sweat = range('gr21');
    const { listings } = buildListings([
      variant(sweat, 'Bottle Green', 'S', { colourHex: '#0b4d2c' }),
      variant(sweat, 'Bottle Green', 'L'),
      variant(sweat, 'Bottle Green', '2XL'),
      variant(sweat, 'Black', 'XL'),
      variant(sweat, 'Black', 'M', { colourHex: '#000000' }),
    ]);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      id: 'group-gr21',
      kind: 'range',
      slug: 'gr21',
      name: 'Range gr21',
      colours: [
        { name: 'Black', hex: '#000000' },
        { name: 'Bottle Green', hex: '#0b4d2c' },
      ],
      sizes: ['S', 'M', 'L', 'XL', '2XL'],
    });
  });

  it('prices a listing from the variants that match', () => {
    const sweat = range('gr21');
    const variants = [
      variant(sweat, 'Black', 'S', { priceGbp: '8.98' }),
      variant(sweat, 'Black', '4XL', { priceGbp: '9.65' }),
    ];
    const all = buildListings(variants).listings[0]!;
    expect([all.priceMinGbp, all.priceMaxGbp]).toEqual(['8.98', '9.65']);
    const big = buildListings(variants, { filters: { size: ['4XL'] } }).listings[0]!;
    expect([big.priceMinGbp, big.priceMaxGbp]).toEqual(['9.65', '9.65']);
  });

  it('lists a range when any variant matches, keeping its other colours on the card', () => {
    const sweat = range('gr21');
    const polo = range('gr11');
    const { listings } = buildListings(
      [variant(sweat, 'Black', 'M'), variant(sweat, 'Red', 'M'), variant(polo, 'Red', 'M')],
      { filters: { colour: ['Black'] } },
    );
    expect(listings.map((l) => l.slug)).toEqual(['gr21']);
    expect(listings[0]!.colours.map((c) => c.name)).toEqual(['Black', 'Red']);
  });

  it('hides out-of-stock variants unless asked for', () => {
    const sweat = range('gr21');
    const gone = range('gr99');
    const variants = [
      variant(sweat, 'Black', 'M', { stockState: 'IN_STOCK' }),
      variant(sweat, 'Pink', 'M', { stockState: 'OUT_OF_STOCK' }),
      variant(gone, 'Black', 'M', { stockState: 'OUT_OF_STOCK' }),
    ];
    const { listings } = buildListings(variants);
    expect(listings.map((l) => l.slug)).toEqual(['gr21']);
    expect(listings[0]!.colours.map((c) => c.name)).toEqual(['Black']);
    expect(listings[0]!.stockState).toBe('IN_STOCK');

    const withGone = buildListings(variants, {
      filters: { stockState: ['IN_STOCK', 'AVAILABLE_FROM_SUPPLIER', 'OUT_OF_STOCK'] },
    }).listings;
    expect(withGone.find((l) => l.slug === 'gr99')!.stockState).toBe('OUT_OF_STOCK');
  });

  it('lists a product on its own when it has no range page', () => {
    const { listings } = buildListings([
      variant(null, 'Black', 'M'),
      variant(range('draft', { isPublished: false }), 'Black', 'M'),
      variant(range('draft', { isPublished: false }), 'Black', 'L'),
      variant(range('', { slug: null }), 'Black', 'M'),
    ]);
    expect(listings).toHaveLength(4);
    expect(listings.every((l) => l.kind === 'product')).toBe(true);
    expect(listings.map((l) => l.slug).sort()).toEqual(['v1', 'v2', 'v3', 'v4']);
  });

  it("uses the range's picture, or the chosen colour's when filtered by colour", () => {
    const sweat = range('gr21', { heroImageUrl: 'https://img/range.jpg' });
    const variants = [
      variant(sweat, 'Red', 'M', { heroImageUrl: 'https://img/red.jpg' }),
      variant(sweat, 'Black', 'M', { heroImageUrl: 'https://img/black.jpg' }),
    ];
    expect(buildListings(variants).listings[0]!.heroImageUrl).toBe('https://img/range.jpg');
    expect(
      buildListings(variants, { filters: { colour: ['Black'] } }).listings[0]!.heroImageUrl,
    ).toBe('https://img/black.jpg');
    const bare = range('gr22');
    expect(
      buildListings([variant(bare, 'Red', 'M', { heroImageUrl: 'https://img/red.jpg' })]).listings[0]!
        .heroImageUrl,
    ).toBe('https://img/red.jpg');
  });

  it('counts facets by listing, not by variant', () => {
    const a = range('a');
    const b = range('b');
    const { facets } = buildListings([
      variant(a, 'Black', 'S'),
      variant(a, 'Black', 'M'),
      variant(a, 'Navy', 'M', { stockState: 'OUT_OF_STOCK' }),
      variant(b, 'Black', 'M', { stockState: 'IN_STOCK', priceGbp: '12.50' }),
    ]);
    expect(facets.colour).toEqual({ Black: 2 });
    expect(facets.size).toEqual({ S: 1, M: 2 });
    expect(facets.stockState).toEqual({ IN_STOCK: 1, AVAILABLE_FROM_SUPPLIER: 1, OUT_OF_STOCK: 1 });
    expect(facets.priceRange).toEqual({ min: '10.00', max: '12.50' });
  });

  it('counts facets before the colour and size filters', () => {
    const a = range('a');
    const b = range('b');
    const { listings, facets } = buildListings(
      [variant(a, 'Black', 'M'), variant(b, 'Navy', 'M')],
      { filters: { colour: ['Navy'] } },
    );
    expect(listings).toHaveLength(1);
    expect(facets.colour).toEqual({ Black: 1, Navy: 1 });
  });

  it('sorts by the from price, the top price, or the newest variant', () => {
    const cheap = range('cheap');
    const dear = range('dear');
    const unpriced = range('unpriced');
    const variants = [
      variant(cheap, 'Black', 'S', { priceGbp: '5.00', createdAt: new Date('2026-01-01') }),
      variant(cheap, 'Black', '5XL', { priceGbp: '30.00', createdAt: new Date('2026-01-01') }),
      variant(dear, 'Black', 'M', { priceGbp: '20.00', createdAt: new Date('2026-03-01') }),
      variant(unpriced, 'Black', 'M', { priceGbp: null, createdAt: new Date('2026-02-01') }),
    ];
    const order = (sort: 'newest' | 'price-asc' | 'price-desc') =>
      buildListings(variants, { sort }).listings.map((l) => l.slug);
    expect(order('price-asc')).toEqual(['cheap', 'dear', 'unpriced']);
    expect(order('price-desc')).toEqual(['cheap', 'dear', 'unpriced']);
    expect(order('newest')).toEqual(['dear', 'unpriced', 'cheap']);
  });
});

describe('listingKey', () => {
  it('keys a published range by its group and anything else by its product', () => {
    const v = variant(range('gr21'), 'Black', 'M');
    expect(listingKey(v)).toBe('range:group-gr21');
    expect(listingKey({ ...v, group: null })).toBe(`product:${v.id}`);
  });
});
