/**
 * Trimming free-text search terms at the schema.
 *
 * Every search in this API becomes ILIKE '%<term>%', so a padded term is not
 * untidy, it is wrong: " V3-PLA " matches nothing and reads to the operator as
 * "no such product" rather than as a stray space. The admin SPA trims before
 * sending, but it is not the only thing that can call these endpoints.
 */
import { describe, expect, it } from 'vitest';
import { searchTermSchema } from './pagination.js';

describe('searchTermSchema', () => {
  it('trims surrounding whitespace', () => {
    expect(searchTermSchema.parse('  V3-PLA-BAS-BLACK  ')).toBe('V3-PLA-BAS-BLACK');
    expect(searchTermSchema.parse('\tpetg\n')).toBe('petg');
  });

  it('treats a whitespace-only term as absent', () => {
    // Not '' — an empty string would still build ILIKE '%%' and return the
    // whole table dressed up as a search result.
    expect(searchTermSchema.parse('   ')).toBeUndefined();
    expect(searchTermSchema.parse('')).toBeUndefined();
  });

  it('leaves an absent term absent', () => {
    expect(searchTermSchema.parse(undefined)).toBeUndefined();
  });

  it('preserves whitespace inside the term', () => {
    expect(searchTermSchema.parse('  matte black  ')).toBe('matte black');
  });

  it('passes a clean term through unchanged', () => {
    expect(searchTermSchema.parse('landau')).toBe('landau');
  });

  it('rejects a non-string rather than coercing it', () => {
    expect(() => searchTermSchema.parse(42)).toThrow();
  });
});
