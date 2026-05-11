/**
 * Unit tests for the pure helpers in `import-uneek-products.ts`.
 *
 * These tests exercise the slug / hex normalisation / family bucketing
 * logic in isolation — no DB, no HTTP. The end-to-end `importUneekProducts`
 * function needs a real Postgres to run against (it uses real Drizzle
 * transactions), so we cover it via the manual run on the VPS rather
 * than here.
 */
import { describe, expect, it } from 'vitest';
import { bucketByFamily, normaliseHex, slugify } from './import-uneek-products.js';
import type { UneekProductRow } from '../src/integrations/suppliers/uneek.connector.js';

describe('slugify', () => {
  it('lowercases + dashes', () => {
    expect(slugify('UX8 - Children')).toBe('ux8-children');
  });
  it('collapses runs of non-alphanumerics', () => {
    expect(slugify('a___ b !! c')).toBe('a-b-c');
  });
  it('strips diacritics', () => {
    expect(slugify('café crème')).toBe('cafe-creme');
  });
  it('falls back to "item" for empty input', () => {
    expect(slugify('')).toBe('item');
    expect(slugify('   ')).toBe('item');
    expect(slugify('!!!')).toBe('item');
  });
  it('trims leading + trailing dashes', () => {
    expect(slugify('---hello---')).toBe('hello');
  });
});

describe('normaliseHex', () => {
  it('accepts hex with hash', () => {
    expect(normaliseHex('#a6a6a6')).toBe('#A6A6A6');
  });
  it('accepts hex without hash', () => {
    expect(normaliseHex('a6a6a6')).toBe('#A6A6A6');
  });
  it('maps the WHITE literal to #FFFFFF', () => {
    expect(normaliseHex('WHITE')).toBe('#FFFFFF');
    expect(normaliseHex('white')).toBe('#FFFFFF');
  });
  it('maps multi-word literal "HEATHER GREY"', () => {
    expect(normaliseHex('HEATHER GREY')).toBe('#A6A6A6');
    expect(normaliseHex('Heather Grey')).toBe('#A6A6A6');
  });
  it('returns null for unknown literal', () => {
    expect(normaliseHex('puce')).toBeNull();
  });
  it('returns null for empty / nullish input', () => {
    expect(normaliseHex(null)).toBeNull();
    expect(normaliseHex(undefined)).toBeNull();
    expect(normaliseHex('')).toBeNull();
    expect(normaliseHex('   ')).toBeNull();
  });
  it('rejects bad hex (wrong length)', () => {
    expect(normaliseHex('#abc')).toBeNull();
    expect(normaliseHex('#abcdefg')).toBeNull();
  });
});

describe('bucketByFamily', () => {
  const r = (overrides: Partial<UneekProductRow>): UneekProductRow => ({
    ProductCode: 'UX8',
    ShortCode: 'X08WH-S',
    ...overrides,
  });
  it('groups rows by ProductCode', () => {
    const out = bucketByFamily([
      r({ ShortCode: 'X08WH-S' }),
      r({ ShortCode: 'X08WH-M' }),
      r({ ProductCode: 'UX9', ShortCode: 'X09BK-S' }),
    ]);
    expect(out.size).toBe(2);
    expect(out.get('UX8')).toHaveLength(2);
    expect(out.get('UX9')).toHaveLength(1);
  });
  it('drops rows missing ProductCode or ShortCode', () => {
    const out = bucketByFamily([
      r({ ProductCode: undefined }),
      r({ ShortCode: undefined }),
      r({}),
    ]);
    expect(out.size).toBe(1);
    expect(out.get('UX8')).toHaveLength(1);
  });
  it('preserves insertion order within a bucket', () => {
    const out = bucketByFamily([
      r({ ShortCode: 'A' }),
      r({ ShortCode: 'B' }),
      r({ ShortCode: 'C' }),
    ]);
    expect(out.get('UX8')!.map((x) => x.ShortCode)).toEqual(['A', 'B', 'C']);
  });
});
