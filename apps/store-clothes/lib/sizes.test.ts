import { describe, expect, it } from 'vitest';
import { compareSizes, letterSizeValue } from './sizes';

describe('letterSizeValue', () => {
  it('places letter sizes around M, with both spellings of the big and small sizes', () => {
    expect(letterSizeValue('M')).toBe(0);
    expect(letterSizeValue('XS')).toBe(-2);
    expect(letterSizeValue('XL')).toBe(2);
    expect(letterSizeValue('2XL')).toBe(letterSizeValue('XXL'));
    expect(letterSizeValue('XXS')).toBe(letterSizeValue('2XS'));
  });

  it('is null for anything else', () => {
    expect(letterSizeValue('7/8')).toBeNull();
    expect(letterSizeValue('One size')).toBeNull();
  });
});

describe('compareSizes', () => {
  const sorted = (sizes: string[]) => [...sizes].sort(compareSizes);

  it('orders letter sizes smallest to largest', () => {
    expect(sorted(['2XL', 'S', 'XL', 'M', '5XL', 'XS', 'L'])).toEqual(['XS', 'S', 'M', 'L', 'XL', '2XL', '5XL']);
  });

  it('orders ages by the first number, and puts words last', () => {
    expect(sorted(['12/13', '3/4', '7/8'])).toEqual(['3/4', '7/8', '12/13']);
    expect(sorted(['One Size', '10', 'M'])).toEqual(['M', '10', 'One Size']);
  });
});
