/**
 * /sitemap.xml — dynamic, built from the published catalogue.
 *
 * Surfaces:
 *   - the home, shop and FAQ pages
 *   - every category and subcategory page at /shop/c/[top](/[sub])
 *   - the first ranges (by sort order) at /shop/[groupSlug]
 *
 * The category pages link on to every range, so crawlers reach the whole
 * catalogue through them. Ranges are listed only up to RANGE_LIMIT because
 * the drop-ship catalogues run to thousands of ranges, and reading them all
 * with their variants on every rebuild would be a very heavy request.
 *
 * Customer-facing in-flight URLs (cart / checkout / track / admin) are
 * intentionally omitted — robots.ts disallows them too.
 *
 * `lastmod` is the current build time for v1. The storefront read
 * endpoints don't yet expose `updated_at`; surfacing that is a follow-up.
 */
import type { MetadataRoute } from 'next';
import { listCategories, listGroups } from '@/lib/smmta';
import { getEnv } from '@/lib/env';

export const revalidate = 3600; // 1 hour — fresh enough for SEO

const MAX_URLS = 5_000;
const RANGE_LIMIT = 1_000;

const STATIC_PATHS: Array<{ path: string; changeFrequency: 'monthly' | 'weekly'; priority: number }> = [
  { path: '/', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/shop', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/faq', changeFrequency: 'monthly', priority: 0.5 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const env = getEnv();
  const baseUrl = (() => {
    try {
      return new URL(env.STORE_BASE_URL).toString().replace(/\/$/, '');
    } catch {
      return 'http://localhost:3000';
    }
  })();
  const lastModified = new Date();

  const [categories, groups] = await Promise.all([
    listCategories().catch(() => []),
    listGroups({ limit: RANGE_LIMIT }).catch(() => []),
  ]);

  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((p) => ({
    url: `${baseUrl}${p.path}`,
    lastModified,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));

  const categoryEntries: MetadataRoute.Sitemap = categories
    .filter((c) => Boolean(c.slug))
    .flatMap((c) => [
      { url: `${baseUrl}/shop/c/${c.slug}`, lastModified, changeFrequency: 'weekly' as const, priority: 0.85 },
      ...c.children
        .filter((s) => Boolean(s.slug))
        .map((s) => ({
          url: `${baseUrl}/shop/c/${c.slug}/${s.slug}`,
          lastModified,
          changeFrequency: 'weekly' as const,
          priority: 0.8,
        })),
    ]);

  const groupEntries: MetadataRoute.Sitemap = groups
    .filter((g): g is typeof g & { slug: string } => Boolean(g.slug))
    .map((g) => ({
      url: `${baseUrl}/shop/${g.slug}`,
      lastModified,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));

  return [...staticEntries, ...categoryEntries, ...groupEntries].slice(0, MAX_URLS);
}
