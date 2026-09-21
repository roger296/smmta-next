import { describe, expect, it } from 'vitest';
import { parseHiddenSections, sectionKey, visibleNavItems } from './nav-sections';

const ITEMS = [
  { label: 'Dashboard', to: '/' },
  { label: 'Orders', to: '/orders' },
  { label: 'Categories', to: '/categories' },
  { label: 'Supplier Orders', to: '/supplier-orders' },
];

describe('sectionKey', () => {
  it('is the path without its slash, and "dashboard" for the root', () => {
    expect(sectionKey('/orders')).toBe('orders');
    expect(sectionKey('/supplier-orders/')).toBe('supplier-orders');
    expect(sectionKey('/')).toBe('dashboard');
  });
});

describe('parseHiddenSections', () => {
  it('reads a comma-separated list, ignoring spaces, case and slashes', () => {
    expect(parseHiddenSections(' Categories, /supplier-orders ,')).toEqual(new Set(['categories', 'supplier-orders']));
  });

  it('hides nothing when unset or empty', () => {
    expect(parseHiddenSections(undefined).size).toBe(0);
    expect(parseHiddenSections('').size).toBe(0);
    expect(parseHiddenSections(' , ').size).toBe(0);
  });

  it('can hide the dashboard only by name', () => {
    expect(parseHiddenSections('dashboard').has('dashboard')).toBe(true);
    expect(parseHiddenSections('/').has('dashboard')).toBe(false);
  });
});

describe('visibleNavItems', () => {
  it('drops the hidden sections and keeps the order of the rest', () => {
    const shown = visibleNavItems(ITEMS, parseHiddenSections('categories,supplier-orders'));
    expect(shown.map((i) => i.label)).toEqual(['Dashboard', 'Orders']);
  });

  it('shows everything when nothing is hidden', () => {
    expect(visibleNavItems(ITEMS, new Set())).toEqual(ITEMS);
  });
});
