/**
 * Unit tests for the storefront extensions to product.schema.ts.
 *
 * No database — these only exercise Zod validation rules.
 */
import { describe, expect, it } from 'vitest';
import {
  createProductSchema,
  updateProductSchema,
  createProductGroupSchema,
  updateProductGroupSchema,
} from './product.schema.js';

describe('createProductSchema — storefront fields', () => {
  it('accepts a product with no storefront fields (back-compat)', () => {
    const result = createProductSchema.safeParse({ name: 'Plain Product' });
    expect(result.success).toBe(true);
  });

  it('accepts a product with full storefront fields', () => {
    const result = createProductSchema.safeParse({
      name: 'Aurora Lamp Smoke',
      groupId: '11111111-1111-4111-8111-111111111111',
      colour: 'Smoke',
      colourHex: '#3a3a3a',
      slug: 'aurora-lamp-smoke',
      shortDescription: 'A short description.',
      longDescription: 'A long description with **markdown**.',
      heroImageUrl: 'https://example.com/hero.jpg',
      galleryImageUrls: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
      seoTitle: 'Aurora Lamp — Smoke',
      seoDescription: 'A designer lamp.',
      seoKeywords: ['lamp', 'designer'],
      isPublished: true,
      sortOrderInGroup: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects colourHex without a leading hash or wrong length', () => {
    expect(createProductSchema.safeParse({ name: 'X', colourHex: '3a3a3a' }).success).toBe(false);
    expect(createProductSchema.safeParse({ name: 'X', colourHex: '#3a3' }).success).toBe(false);
    expect(createProductSchema.safeParse({ name: 'X', colourHex: '#zzzzzz' }).success).toBe(false);
  });

  it('accepts colourHex with valid #RRGGBB format', () => {
    expect(createProductSchema.safeParse({ name: 'X', colourHex: '#ABCDEF' }).success).toBe(true);
    expect(createProductSchema.safeParse({ name: 'X', colourHex: '#abcdef' }).success).toBe(true);
  });

  it('rejects shortDescription longer than 280 chars', () => {
    const tooLong = 'x'.repeat(281);
    const result = createProductSchema.safeParse({ name: 'X', shortDescription: tooLong });
    expect(result.success).toBe(false);
  });

  it('rejects seoTitle longer than 70 chars and seoDescription longer than 160', () => {
    expect(
      createProductSchema.safeParse({ name: 'X', seoTitle: 'x'.repeat(71) }).success,
    ).toBe(false);
    expect(
      createProductSchema.safeParse({ name: 'X', seoDescription: 'x'.repeat(161) }).success,
    ).toBe(false);
  });

  it('rejects a non-URL heroImageUrl', () => {
    const result = createProductSchema.safeParse({ name: 'X', heroImageUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID groupId', () => {
    const result = createProductSchema.safeParse({ name: 'X', groupId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('accepts groupId = null (standalone product)', () => {
    const result = createProductSchema.safeParse({ name: 'Standalone', groupId: null });
    expect(result.success).toBe(true);
  });
});

describe('updateProductSchema — partial', () => {
  it('accepts an empty patch', () => {
    expect(updateProductSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a patch that only touches storefront fields', () => {
    const result = updateProductSchema.safeParse({
      isPublished: true,
      slug: 'new-slug',
    });
    expect(result.success).toBe(true);
  });
});

describe('createProductGroupSchema — storefront fields', () => {
  it('accepts a minimal group with just a name', () => {
    expect(createProductGroupSchema.safeParse({ name: 'Aurora Range' }).success).toBe(true);
  });

  it('accepts a group with full storefront content', () => {
    const result = createProductGroupSchema.safeParse({
      name: 'Aurora Range',
      slug: 'aurora-range',
      shortDescription: 'A range of designer lamps.',
      longDescription: '## Long form\n\ncopy.',
      heroImageUrl: 'https://example.com/hero.jpg',
      galleryImageUrls: ['https://example.com/1.jpg'],
      seoTitle: 'Aurora Range',
      seoDescription: 'Designer lamp range.',
      seoKeywords: ['lamp'],
      isPublished: true,
      sortOrder: 5,
    });
    expect(result.success).toBe(true);
  });

  it('updateProductGroupSchema accepts an empty patch', () => {
    expect(updateProductGroupSchema.safeParse({}).success).toBe(true);
  });
});
