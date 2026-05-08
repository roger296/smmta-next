import { describe, expect, it } from 'vitest';
import { listAxisValues, resolveVariant } from './variant-selector';
import type { FullVariant } from './api-types';

const v = (size: string, colour: string, stockState: 'IN_STOCK' | 'OUT_OF_STOCK' = 'IN_STOCK'): FullVariant => ({
  id: `${size}-${colour}`,
  slug: `${size}-${colour}`,
  name: `${colour} (${size})`,
  colour,
  colourHex: null,
  priceGbp: '12.00',
  availableQty: stockState === 'IN_STOCK' ? 5 : 0,
  stockState,
  attributes: { size, colour },
  heroImageUrl: null,
  shortDescription: null,
  longDescription: null,
  galleryImageUrls: null,
  seoTitle: null,
  seoDescription: null,
  seoKeywords: null,
  sortOrderInGroup: 0,
});

describe('listAxisValues', () => {
  it('returns sorted distinct sizes with stock flags', () => {
    const variants = [
      v('S', 'Red'),
      v('M', 'Red'),
      v('L', 'Red', 'OUT_OF_STOCK'),
      v('M', 'Blue'),
    ];
    const sizes = listAxisValues('size', variants);
    expect(sizes.map((s) => s.value)).toEqual(['S', 'M', 'L']); // size order
    expect(sizes.find((s) => s.value === 'L')!.hasStock).toBe(false);
    expect(sizes.find((s) => s.value === 'M')!.hasStock).toBe(true);
  });

  it('alphabetises colour axis', () => {
    const variants = [v('S', 'Red'), v('S', 'Amber'), v('S', 'Blue')];
    expect(listAxisValues('colour', variants).map((c) => c.value)).toEqual(['Amber', 'Blue', 'Red']);
  });
});

describe('resolveVariant', () => {
  const variants = [v('S', 'Red'), v('M', 'Red'), v('M', 'Blue')];
  it('returns the matching variant', () => {
    expect(resolveVariant(variants, { size: 'M', colour: 'Blue' })?.id).toBe('M-Blue');
  });
  it('returns null when no variant matches', () => {
    expect(resolveVariant(variants, { size: 'L', colour: 'Red' })).toBeNull();
  });
});
