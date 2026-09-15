import { describe, expect, it } from 'vitest';
import { colourSummary, listingHref, priceLabel, sizeSummary, swatchColour } from './listing';

const sweatshirt = {
  kind: 'range' as const,
  slug: 'gr21',
  colours: [
    { name: 'Black', hex: '#000000' },
    { name: 'Bottle Green', hex: null },
  ],
  sizes: ['S', 'M', 'L', '2XL'],
};

describe('listingHref', () => {
  it('opens the range page', () => {
    expect(listingHref(sweatshirt)).toBe('/shop/gr21');
  });

  it('opens on the one colour and size chosen in the filters', () => {
    expect(listingHref(sweatshirt, { colour: ['Bottle Green'], size: ['2XL'] })).toBe(
      '/shop/gr21?colour=Bottle+Green&size=2XL',
    );
  });

  it('ignores a choice of several, or of one the range lacks', () => {
    expect(listingHref(sweatshirt, { colour: ['Black', 'Bottle Green'] })).toBe('/shop/gr21');
    expect(listingHref(sweatshirt, { colour: ['Red'], size: ['6XL'] })).toBe('/shop/gr21');
  });

  it('opens a product with no range on its own page', () => {
    expect(listingHref({ ...sweatshirt, kind: 'product', slug: 'gr21bg2xl' })).toBe('/shop/p/gr21bg2xl');
    expect(listingHref({ ...sweatshirt, slug: null })).toBe('/shop');
  });
});

describe('priceLabel', () => {
  it('shows one price, or "From" the lowest', () => {
    expect(priceLabel({ priceMinGbp: '8.98', priceMaxGbp: '8.98' })).toBe('£8.98');
    expect(priceLabel({ priceMinGbp: '9.00', priceMaxGbp: '9' })).toBe('£9.00');
    expect(priceLabel({ priceMinGbp: '8.98', priceMaxGbp: '10.33' })).toBe('From £8.98');
    expect(priceLabel({ priceMinGbp: null, priceMaxGbp: null })).toBeNull();
  });
});

describe('sizeSummary', () => {
  it('spans letter sizes and counts the rest', () => {
    expect(sizeSummary([])).toBeNull();
    expect(sizeSummary(['M'])).toBe('Size M');
    expect(sizeSummary(['XS', 'M', '5XL'])).toBe('Sizes XS – 5XL');
    expect(sizeSummary(['3/4', '5/6', '7/8'])).toBe('3 sizes');
  });
});

describe('colourSummary', () => {
  it('names one colour and counts several', () => {
    expect(colourSummary([])).toBeNull();
    expect(colourSummary([{ name: 'Black', hex: null }])).toBe('Black');
    expect(colourSummary(sweatshirt.colours)).toBe('2 colours');
  });
});

describe('swatchColour', () => {
  it('accepts hex colours only', () => {
    expect(swatchColour('#0b4d2c')).toBe('#0b4d2c');
    expect(swatchColour('#fff')).toBe('#fff');
    expect(swatchColour('red')).toBeNull();
    expect(swatchColour(null)).toBeNull();
  });
});
