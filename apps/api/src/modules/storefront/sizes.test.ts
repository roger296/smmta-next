import { describe, expect, it } from 'vitest';
import { compareSizes, letterSizeValue } from './sizes.js';

describe('letterSizeValue', () => {
  it('places letter sizes around M', () => {
    expect(letterSizeValue('M')).toBe(0);
    expect(letterSizeValue('S')).toBe(-1);
    expect(letterSizeValue('XS')).toBe(-2);
    expect(letterSizeValue('L')).toBe(1);
    expect(letterSizeValue('XL')).toBe(2);
  });

  it('treats the X and number spellings alike', () => {
    expect(letterSizeValue('2XL')).toBe(letterSizeValue('XXL'));
    expect(letterSizeValue('3XL')).toBe(letterSizeValue('XXXL'));
    expect(letterSizeValue('2XS')).toBe(letterSizeValue('XXS'));
  });

  it('is null for codes that are not letter sizes', () => {
    expect(letterSizeValue('2L')).toBeNull();
    expect(letterSizeValue('XM')).toBeNull();
    expect(letterSizeValue('One size')).toBeNull();
    expect(letterSizeValue('30R')).toBeNull();
  });
});

describe('compareSizes', () => {
  const sorted = (sizes: string[]) => [...sizes].sort(compareSizes);

  it('orders letter sizes smallest to largest', () => {
    expect(sorted(['XL', 'S', '2XL', 'M', '6XL', 'XS', 'L', '4XL', '3XL'])).toEqual([
      'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '6XL',
    ]);
  });

  it('puts combined sizes and fits beside their letter size', () => {
    expect(sorted(['L/XL', 'M', 'S/M', 'S'])).toEqual(['S', 'S/M', 'M', 'L/XL']);
    expect(sorted(['LR', 'MR', 'SR'])).toEqual(['SR', 'MR', 'LR']);
    expect(sorted(['L (CLS)', 'S (CLS)', 'M (CLS)'])).toEqual(['S (CLS)', 'M (CLS)', 'L (CLS)']);
  });

  it('orders ages, waists and necks by their number', () => {
    expect(sorted(['12/13', '3/4', '7/8', '5/6'])).toEqual(['3/4', '5/6', '7/8', '12/13']);
    expect(sorted(['34L', '30R', '32R'])).toEqual(['30R', '32R', '34L']);
    expect(sorted(['16.5', '15.5', '17'])).toEqual(['15.5', '16.5', '17']);
  });

  it('puts letter sizes first and words last', () => {
    expect(sorted(['One Size', '10', 'M'])).toEqual(['M', '10', 'One Size']);
  });
});
