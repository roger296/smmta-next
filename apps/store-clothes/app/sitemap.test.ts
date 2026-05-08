/**
 * Unit tests for the dynamic sitemap + robots routes. We mock
 * `lib/smmta` so the tests don't require a running SMMTA API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listGroupsMock = vi.fn();

vi.mock('@/lib/smmta', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/smmta')>('@/lib/smmta');
  return {
    ...actual,
    listGroups: listGroupsMock,
  };
});

beforeEach(() => {
  process.env.STORE_BASE_URL = 'https://filament.shop';
  listGroupsMock.mockReset();
});

afterEach(() => {
  delete process.env.STORE_BASE_URL;
});

describe('sitemap', () => {
  it('emits the static + group entries with absolute URLs', async () => {
    listGroupsMock.mockResolvedValueOnce([
      {
        id: '1',
        slug: 'aurora',
        name: 'Aurora',
        shortDescription: null,
        heroImageUrl: null,
        galleryImageUrls: null,
        seoTitle: null,
        seoDescription: null,
        sortOrder: 0,
        priceRange: null,
        totalAvailableQty: 5,
        variants: [],
      },
      {
        id: '2',
        slug: null, // unpublished — skipped
        name: 'Hidden',
        shortDescription: null,
        heroImageUrl: null,
        galleryImageUrls: null,
        seoTitle: null,
        seoDescription: null,
        sortOrder: 1,
        priceRange: null,
        totalAvailableQty: 0,
        variants: [],
      },
    ]);

    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);

    expect(urls).toContain('https://filament.shop/');
    expect(urls).toContain('https://filament.shop/shop');
    expect(urls).toContain('https://filament.shop/faq');
    expect(urls).toContain('https://filament.shop/shop/aurora');
    expect(urls).not.toContain('https://filament.shop/shop/null');
  });

  it('still returns the static entries when the catalogue read fails', async () => {
    listGroupsMock.mockRejectedValueOnce(new Error('SMMTA down'));

    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);

    expect(urls).toContain('https://filament.shop/');
    expect(urls).toContain('https://filament.shop/shop');
    expect(urls).toContain('https://filament.shop/faq');
  });
});

describe('robots', () => {
  it('disallows admin/api/cart/checkout/track and references the sitemap', async () => {
    const robots = (await import('./robots')).default;
    const out = robots();
    const rules = Array.isArray(out.rules) ? out.rules[0]! : out.rules;
    expect(rules?.disallow).toEqual(
      expect.arrayContaining([
        '/admin',
        '/admin/',
        '/api',
        '/api/',
        '/cart',
        '/checkout',
        '/track',
        '/track/',
      ]),
    );
    expect(out.sitemap).toBe('https://filament.shop/sitemap.xml');
  });
});

describe('manifest', () => {
  it('emits a valid PWA manifest with name + theme color + icons', async () => {
    const manifest = (await import('./manifest')).default;
    const out = manifest();
    expect(out.name).toBe('Filament Store');
    expect(out.short_name).toBe('Filament');
    expect(out.start_url).toBe('/');
    expect(out.display).toBe('standalone');
    expect(Array.isArray(out.icons)).toBe(true);
    expect(out.icons?.length).toBeGreaterThan(0);
  });
});
