import { afterEach, describe, expect, it } from 'vitest';
import {
  UNCATEGORISED,
  groupByCategory,
  isCollapsed,
  loadCollapsed,
  saveCollapsed,
  toggleCollapsed,
} from './count-sections';

interface L {
  productId: string;
  itemCategoryName?: string | null;
  counted?: boolean;
}

const counted = (l: L) => l.counted === true;

function line(productId: string, itemCategoryName?: string | null, isCounted = false): L {
  return { productId, itemCategoryName, counted: isCounted };
}

describe('groupByCategory', () => {
  it('splits the sheet into one section per category', () => {
    const sections = groupByCategory(
      [line('1', 'Dry Stock'), line('2', 'Bar'), line('3', 'Dry Stock')],
      counted,
    );
    expect(sections.map((s) => s.name)).toEqual(['Bar', 'Dry Stock']);
    expect(sections.find((s) => s.name === 'Dry Stock')?.lines).toHaveLength(2);
  });

  it('sorts named categories A to Z', () => {
    const sections = groupByCategory(
      [line('1', 'Packaging'), line('2', 'Bar'), line('3', 'Cleaning')],
      counted,
    );
    expect(sections.map((s) => s.name)).toEqual(['Bar', 'Cleaning', 'Packaging']);
  });

  // It is a residue, not a category — it belongs at the bottom with the odds
  // and ends, not alphabetically between "Bar" and "Cleaning".
  it('puts Uncategorised last, not alphabetically', () => {
    const sections = groupByCategory(
      [line('1', null), line('2', 'Zinc Supplies'), line('3', 'Bar')],
      counted,
    );
    expect(sections.map((s) => s.name)).toEqual(['Bar', 'Zinc Supplies', UNCATEGORISED]);
  });

  it.each([null, undefined, '', '   '])('treats %p as Uncategorised', (value) => {
    const sections = groupByCategory([line('1', value)], counted);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.name).toBe(UNCATEGORISED);
  });

  it('counts progress per section, not just overall', () => {
    const sections = groupByCategory(
      [
        line('1', 'Dry Stock', true),
        line('2', 'Dry Stock', false),
        line('3', 'Bar', true),
      ],
      counted,
    );
    expect(sections.find((s) => s.name === 'Dry Stock')).toMatchObject({ counted: 1, total: 2 });
    expect(sections.find((s) => s.name === 'Bar')).toMatchObject({ counted: 1, total: 1 });
  });

  it('keeps every line — grouping must never drop one', () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      line(String(i), i % 3 === 0 ? null : `Cat ${i % 5}`),
    );
    const sections = groupByCategory(lines, counted);
    const seen = sections.flatMap((s) => s.lines.map((l) => l.productId));
    expect(new Set(seen).size).toBe(50);
    expect(sections.reduce((sum, s) => sum + s.total, 0)).toBe(50);
  });

  it('preserves the order lines arrived in within a section', () => {
    const sections = groupByCategory(
      [line('a', 'Bar'), line('b', 'Dry Stock'), line('c', 'Bar')],
      counted,
    );
    expect(sections.find((s) => s.name === 'Bar')?.lines.map((l) => l.productId)).toEqual([
      'a',
      'c',
    ]);
  });

  it('returns nothing for an empty sheet', () => {
    expect(groupByCategory([], counted)).toEqual([]);
  });
});

describe('collapse state', () => {
  // A category added later must not arrive folded and invisible.
  it('treats an unknown section as OPEN', () => {
    expect(isCollapsed([], 'Bar')).toBe(false);
    expect(isCollapsed(['Dry Stock'], 'Bar')).toBe(false);
  });

  it('toggles a section closed and open again', () => {
    const once = toggleCollapsed([], 'Bar');
    expect(once).toEqual(['Bar']);
    expect(isCollapsed(once, 'Bar')).toBe(true);
    expect(toggleCollapsed(once, 'Bar')).toEqual([]);
  });

  it('leaves the other sections alone', () => {
    expect(toggleCollapsed(['Bar', 'Cleaning'], 'Bar')).toEqual(['Cleaning']);
  });

  it('does not mutate the array it is given', () => {
    const before = ['Bar'];
    toggleCollapsed(before, 'Cleaning');
    expect(before).toEqual(['Bar']);
  });
});

describe('remembering it on the device', () => {
  afterEach(() => localStorage.clear());

  it('round-trips', () => {
    saveCollapsed(['Bar', 'Cleaning']);
    expect(loadCollapsed()).toEqual(['Bar', 'Cleaning']);
  });

  it('starts with nothing collapsed', () => {
    expect(loadCollapsed()).toEqual([]);
  });

  it('ignores a corrupted value rather than failing the screen', () => {
    localStorage.setItem('autostock.stock-take.collapsed-sections', 'not json');
    expect(loadCollapsed()).toEqual([]);
  });

  it('ignores a stored value of the wrong shape', () => {
    localStorage.setItem('autostock.stock-take.collapsed-sections', '{"a":1}');
    expect(loadCollapsed()).toEqual([]);
    localStorage.setItem('autostock.stock-take.collapsed-sections', '[1,2,"Bar"]');
    expect(loadCollapsed()).toEqual(['Bar']);
  });
});
