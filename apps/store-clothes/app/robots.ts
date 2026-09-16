/**
 * /robots.txt — emitted by Next from this module.
 *
 * Allow `/` and the catalogue. Disallow admin, API, in-flight customer
 * surfaces (cart / checkout / order tracking) — none of those should ever
 * be crawled or indexed. Sitemap reference points at the dynamic
 * sitemap.xml below.
 *
 * Rendered per request: prerendering baked in whatever STORE_BASE_URL the
 * image was built with, and Coolify builds every storefront with the same
 * project settings, so the Clothes Shop shipped the Filament Store's address
 * (2026-09-15).
 */
import type { MetadataRoute } from 'next';
import { getEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const env = getEnv();
  const baseUrl = (() => {
    try {
      return new URL(env.STORE_BASE_URL).toString().replace(/\/$/, '');
    } catch {
      return 'http://localhost:3000';
    }
  })();
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
        disallow: [
          '/admin',
          '/admin/',
          '/api',
          '/api/',
          '/cart',
          '/checkout',
          '/track',
          '/track/',
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
