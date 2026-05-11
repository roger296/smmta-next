/**
 * /manifest.webmanifest — PWA manifest. Lighthouse SEO + Best-Practices
 * rewards an installable manifest even for a non-PWA storefront.
 *
 * The icons reference the `/icon` and `/apple-icon` static metadata
 * routes (apps/store/app/icon.png and apple-icon.png) — the storefront
 * presents under the CleverDeals parent identity, so the mark is the
 * CleverDeals favicon, not a Filament-specific glyph.
 *
 * `sizes: 'any'` tells browsers the source is high-resolution and they
 * may downscale freely; the underlying PNG is 512×512.
 */
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Clothes Shop',
    short_name: 'Clothes',
    description:
      'Friendly clothes in real sizes — fast UK delivery, easy returns.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ECECE8',
    theme_color: '#15161A',
    icons: [
      {
        src: '/icon',
        sizes: 'any',
        type: 'image/png',
      },
      {
        src: '/apple-icon',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  };
}
