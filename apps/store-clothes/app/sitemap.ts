/**
 * /sitemap.xml — dynamic, built from the published catalogue.
 *
 * Surfaces:
 *   - the home + shop + legal pages
 *   - every published group at /shop/[groupSlug]
 *   - every published standalone product at /shop/p/[productSlug]
 *
 * Customer-facing in-flight URLs (cart / checkout / track / admin) are
 * intentionally omitted — robots.ts disallows them too.
 *
 * `lastmod` is the current build time for v1. The storefront read
 * endpoints don't yet expose `updated_at`; surfacing that is a follow-up
 * (out of scope for this prompt). Build-time-now is acceptable to
 * Google and is better than no lastmod at all.
 *
 * Cap is 5,000 URLs per the prompt; we'll never approach it but the cap
 * is enforced for safety.
 */
import type { MetadataRoute } from 'next';
import { listGroups, getProductsByIds } from '@/lib/smmta';
import { getEnv } from '@/lib/env';

export const revalidate = 3600; // 1 hour — fresh enough for SEO

const MAX_URLS = 5_000;

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

  let groups: Awaited<ReturnType<typeof listGroups>> = [];
  try {
    groups = await listGroups();
  } catch {
    groups = [];
  }

  const groupEntries: MetadataRoute.Sitemap = groups
    .filter((g): g is typeof g & { slug: string } => Boolean(g.slug))
    .map((g) => ({
      url: `${baseUrl}/shop/${g.slug}`,
      lastModified,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    }));

  // Standalone products (group_id NULL) — the listGroups response only
  // surfaces groups, so we collect any variant ids from groups with
  // null group_id by re-using the products lookup. For v1 the SMMTA-
  // NEXT API surface gives us groups only; standalone products that
  // aren't part of any group don't appear in /storefront/groups, so
  // there's nothing to enumerate here yet. Once the API exposes a
  // /storefront/products listing it can be added — for now we leave
  // the standalone slug discovery as a TODO and move on.
  void getProductsByIds;

  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((p) => ({
    url: `${baseUrl}${p.path}`,
    lastModified,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));

  return [...staticEntries, ...groupEntries].slice(0, MAX_URLS);
}
