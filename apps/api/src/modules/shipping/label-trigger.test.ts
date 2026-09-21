import { describe, expect, it } from 'vitest';
import { labelWantedFor } from './label-trigger.js';

describe('labelWantedFor', () => {
  it('buys a label for a paid storefront order, whatever the allocation setting', () => {
    expect(labelWantedFor('order.paid', 'storefront', false)).toBe(true);
    expect(labelWantedFor('order.paid', 'storefront', true)).toBe(true);
  });

  it('leaves other payments alone: they ship later', () => {
    expect(labelWantedFor('order.paid', 'preorder', true)).toBe(false);
    expect(labelWantedFor('order.paid', undefined, true)).toBe(false);
  });

  it('buys a label on full allocation only when the setting is on', () => {
    expect(labelWantedFor('order.allocated', 'API', true)).toBe(true);
    expect(labelWantedFor('order.allocated', 'CSV', true)).toBe(true);
    expect(labelWantedFor('order.allocated', 'MANUAL', false)).toBe(false);
  });

  it('ignores every other event', () => {
    expect(labelWantedFor('order.created', 'API', true)).toBe(false);
    expect(labelWantedFor('order.lines_changed', 'storefront', true)).toBe(false);
  });
});
