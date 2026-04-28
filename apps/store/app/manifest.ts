/**
 * /manifest.webmanifest — PWA manifest. Lighthouse SEO + Best-Practices
 * rewards an installable manifest even for a non-PWA storefront.
 *
 * The icons reference the `/icon` (favicon, 32) and `/apple-icon` (180)
 * file-based metadata routes also under `app/`, so a single source of
 * truth governs the favicon, manifest, and apple-touch-icon.
 */
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Filament Store',
    short_name: 'Filament',
    description: 'Hand-finished LED filament lighting.',
    start_url: '/',
    display: 'standalone',
    background_color: '#fafaf7',
    theme_color: '#18181b',
    icons: [
      {
        src: '/icon',
        sizes: '32x32',
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
