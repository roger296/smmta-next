/**
 * Nav highlighting. `/stock` is a prefix of `/stock/by-site` and
 * `/stock/reorder`, so a plain startsWith lit up two rows at once and left you
 * unable to tell which page you were on.
 */
import { describe, expect, it } from 'vitest';
import { activePath, NAV_ITEMS } from './sidebar';

const at = (p: string) => activePath(p, NAV_ITEMS);

describe('activePath', () => {
  it('picks the most specific match, not the shortest', () => {
    expect(at('/stock/by-site')).toBe('/stock/by-site');
    expect(at('/stock/reorder')).toBe('/stock/reorder');
  });

  it('still matches the parent on its own page', () => {
    expect(at('/stock')).toBe('/stock');
    expect(at('/stock/adjust')).toBe('/stock');
  });

  it('matches the dashboard only exactly', () => {
    expect(at('/')).toBe('/');
    expect(at('/products')).toBe('/products');
  });

  it('does not match a route that merely shares a name prefix', () => {
    // /reorder must not light up for /stock/reorder, nor vice versa.
    expect(at('/reorder')).toBe('/reorder');
  });

  it('returns null for a page with no nav entry', () => {
    expect(at('/customers')).toBeNull();
  });
});
