import { describe, expect, it } from 'vitest';
import { colourSuffix, nameIncludesColour, productDisplayName } from './display-name';

describe('colourSuffix', () => {
  it('suppresses the colour when the name already ends with it (the seeded shape)', () => {
    // Catalogue names carry the colour, which is what produced "— Brown — Brown".
    expect(colourSuffix('Landau PLA Basic 1.75mm 1kg — Brown', 'Brown')).toBeNull();
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(colourSuffix('Landau PLA — BROWN', 'brown')).toBeNull();
    expect(colourSuffix('Landau PLA — Brown ', ' Brown')).toBeNull();
  });

  it('matches regardless of which separator precedes the colour', () => {
    expect(colourSuffix('Landau PLA - Brown', 'Brown')).toBeNull();
    expect(colourSuffix('Landau PLA, Brown', 'Brown')).toBeNull();
    expect(colourSuffix('Landau PLA (Brown)', 'Brown')).toBeNull();
  });

  it('returns the colour when the name does not carry it', () => {
    expect(colourSuffix('Landau PLA Basic 1.75mm 1kg', 'Brown')).toBe('Brown');
  });

  it('does not false-positive on a colour that only appears mid-name', () => {
    // "Brown" here is part of the range name, not the trailing variant.
    expect(colourSuffix('Brown Bear PLA 1kg', 'Blue')).toBe('Blue');
  });

  it('handles multi-word colours', () => {
    expect(colourSuffix('Landau PLA — Fire Engine Red', 'Fire Engine Red')).toBeNull();
    expect(colourSuffix('Landau PLA', 'Fire Engine Red')).toBe('Fire Engine Red');
  });

  it('returns null for missing input rather than rendering an empty suffix', () => {
    expect(colourSuffix('Landau PLA', null)).toBeNull();
    expect(colourSuffix(null, 'Brown')).toBe('Brown');
  });
});

describe('nameIncludesColour', () => {
  it('treats an empty colour as already present', () => {
    expect(nameIncludesColour('Landau PLA', '')).toBe(true);
  });
});

describe('productDisplayName', () => {
  it('joins only when needed', () => {
    expect(productDisplayName('Landau PLA — Brown', 'Brown')).toBe('Landau PLA — Brown');
    expect(productDisplayName('Landau PLA', 'Brown')).toBe('Landau PLA — Brown');
    expect(productDisplayName('Landau PLA')).toBe('Landau PLA');
  });
});
