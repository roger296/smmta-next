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
 * `lastmod` is the render time of this route. The storefront read
 * endpoints still don't expose a per-product `updated_at`; with a 1-hour
 * revalidate that gives Google a freshness signal that moves with the
 * catalogue rather than being frozen at deploy time.
 *
 * Cap is 5,000 URLs per the prompt; we'll never approach it but the cap
 * is enforced for safety.
 */
import type { MetadataRoute } from 'next';
import { listGroups, getProductsByIds } from '@/lib/smmta';
import { getEnv } from '@/lib/env';
import { MATERIALS } from '@/lib/materials';

export const revalidate = 3600; // 1 hour — fresh enough for SEO

const MAX_URLS = 5_000;

const STATIC_PATHS: Array<{ path: string; changeFrequency: 'monthly' | 'weekly'; priority: number }> = [
  { path: '/', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/shop', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/faq', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/about', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/legal/returns', changeFrequency: 'monthly', priority: 0.4 },
  { path: '/legal/terms', changeFrequency: 'monthly', priority: 0.3 },
  { path: '/legal/privacy', changeFrequency: 'monthly', priority: 0.3 },
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

  // Variant pages at /shop/p/<slug>.
  //
  // These were previously absent, which meant the sitemap advertised
  // six URLs and told Google the catalogue didn't exist. Every group's
  // thin-variant list already carries the slug, so no extra round trip
  // is needed — and now that /shop/p/* is indexable and self-canonical
  // these are the pages carrying the long-tail colour queries.
  //
  // Deduped: a variant appearing under two groups would otherwise emit
  // a duplicate URL, which Search Console flags.
  const seenVariantSlugs = new Set<string>();
  const variantEntries: MetadataRoute.Sitemap = [];
  for (const group of groups) {
    for (const variant of group.variants ?? []) {
      if (!variant.slug || seenVariantSlugs.has(variant.slug)) continue;
      seenVariantSlugs.add(variant.slug);
      variantEntries.push({
        url: `${baseUrl}/shop/p/${variant.slug}`,
        lastModified,
        changeFrequency: 'weekly' as const,
        // Below the group page: the group is the stronger landing page
        // for a range, the variant wins the specific colour query.
        priority: 0.7,
      });
    }
  }

  void getProductsByIds;

  // Material category pages. High priority: these are the pages
  // targeting "PETG filament UK" style queries, which carry more volume
  // than any individual product name.
  const materialEntries: MetadataRoute.Sitemap = MATERIALS.map((m) => ({
    url: `${baseUrl}/${m.slug}`,
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 0.9,
  }));

  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((p) => ({
    url: `${baseUrl}${p.path}`,
    lastModified,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));

  return [...staticEntries, ...materialEntries, ...groupEntries, ...variantEntries].slice(
    0,
    MAX_URLS,
  );
}
