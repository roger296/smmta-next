import { describe, expect, it } from 'vitest';
import { splitAliases } from './supplier-mappings-tab';

describe('splitAliases', () => {
  it('splits on commas', () => {
    expect(splitAliases('A 33891, A33891')).toEqual(['A 33891', 'A33891']);
  });

  // A supplier code legitimately contains a space — "A 33891" is one code, not
  // two — so splitting on whitespace would break the very case this exists for.
  it('keeps a space INSIDE a code', () => {
    expect(splitAliases('A 33891')).toEqual(['A 33891']);
  });

  it('trims each one', () => {
    expect(splitAliases('  A33891 ,   A 33891  ')).toEqual(['A33891', 'A 33891']);
  });

  it('drops empties from trailing or doubled commas', () => {
    expect(splitAliases('A33891,,')).toEqual(['A33891']);
    expect(splitAliases(', A33891 ,')).toEqual(['A33891']);
  });

  it('returns nothing for an empty box', () => {
    expect(splitAliases('')).toEqual([]);
    expect(splitAliases('   ')).toEqual([]);
  });
});
