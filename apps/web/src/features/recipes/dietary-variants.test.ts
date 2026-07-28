/**
 * Flattening the four dietary lists into API lines.
 *
 * The risk here is quantities. A *_REMOVE line takes the whole ingredient out,
 * so its quantity means nothing — but the form still holds a value in that
 * field. If it leaked through as a positive number, a "remove" would read as
 * an "add" everywhere downstream, and the gluten-free version would silently
 * gain the very ingredient it was meant to lose.
 */
import { describe, expect, it } from 'vitest';
import { dietaryLinesToPayload, emptyDietaryLines } from './dietary-variants';

describe('dietaryLinesToPayload', () => {
  it('is empty when nothing has been set', () => {
    expect(dietaryLinesToPayload(emptyDietaryLines())).toEqual([]);
  });

  it('zeroes the quantity on removals whatever the form held', () => {
    const d = emptyDietaryLines();
    d.GF_REMOVE = [{ productId: 'p1', qtyPerCover: '250' }];
    d.VEGAN_REMOVE = [{ productId: 'p2', qtyPerCover: '999' }];
    const out = dietaryLinesToPayload(d);
    expect(out).toHaveLength(2);
    for (const line of out) expect(line.qtyPerCover).toBe(0);
  });

  it('keeps the quantity on additions', () => {
    const d = emptyDietaryLines();
    d.GF_ADD = [{ productId: 'gf-flour', qtyPerCover: '0.25' }];
    expect(dietaryLinesToPayload(d)).toEqual([
      { productId: 'gf-flour', qtyPerCover: 0.25, variant: 'GF_ADD' },
    ]);
  });

  it('drops half-filled rows rather than sending them', () => {
    const d = emptyDietaryLines();
    // No product chosen yet.
    d.GF_ADD = [{ productId: '', qtyPerCover: '1' }];
    // Product chosen but no quantity — an addition of nothing is not an
    // addition.
    d.VEGAN_ADD = [{ productId: 'oat-milk', qtyPerCover: '' }];
    expect(dietaryLinesToPayload(d)).toEqual([]);
  });

  it('keeps a removal with no quantity, because it never needed one', () => {
    const d = emptyDietaryLines();
    d.VEGAN_REMOVE = [{ productId: 'butter', qtyPerCover: '' }];
    expect(dietaryLinesToPayload(d)).toEqual([
      { productId: 'butter', qtyPerCover: 0, variant: 'VEGAN_REMOVE' },
    ]);
  });

  it('tags every line with the list it came from', () => {
    const d = emptyDietaryLines();
    d.GF_REMOVE = [{ productId: 'a', qtyPerCover: '0' }];
    d.GF_ADD = [{ productId: 'b', qtyPerCover: '1' }];
    d.VEGAN_REMOVE = [{ productId: 'c', qtyPerCover: '0' }];
    d.VEGAN_ADD = [{ productId: 'd', qtyPerCover: '2' }];
    expect(dietaryLinesToPayload(d).map((l) => l.variant)).toEqual([
      'GF_REMOVE',
      'GF_ADD',
      'VEGAN_REMOVE',
      'VEGAN_ADD',
    ]);
  });
});
