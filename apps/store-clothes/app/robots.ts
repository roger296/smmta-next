/**
 * /robots.txt — emitted by Next from this module.
 *
 * Allow `/` and the catalogue. Disallow admin, API, in-flight customer
 * surfaces (cart / checkout / order tracking) — none of those should ever
 * be crawled or indexed. Sitemap reference points at the dynamic
 * sitemap.xml below.
 */
import type { MetadataRoute } from 'next';
import { getEnv } from '@/lib/env';

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
