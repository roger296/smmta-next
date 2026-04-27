/**
 * Catalogue (`/shop`). RSC, revalidate 60s.
 *
 * Pre-computes catalogue-wide price extents and the unique colour list,
 * then hands the rest off to the client filter island.
 */
import type { Metadata } from 'next';
import { listGroups } from '@/lib/smmta';
import { getEnv } from '@/lib/env';
import { breadcrumbLd, stringifyJsonLd } from '@/lib/seo/structured-data';
import { CatalogueGrid } from '../_components/catalogue-grid';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Shop',
  description:
    'The full Filament Store range. Browse by colour, filter by price, every lamp dimmable on any standard switch.',
  alternates: { canonical: '/shop' },
  openGraph: {
    type: 'website',
    url: '/shop',
    title: 'Shop | Filament Store',
    description: 'The full Filament Store range, by colour and price.',
  },
  robots: { index: true, follow: true },
};

export default async function ShopPage() {
  const env = getEnv();
  const baseUrl = (() => {
    try {
      return new URL(env.STORE_BASE_URL);
    } catch {
      return new URL('http://localhost:3000');
    }
  })();

  let groups: Awaited<ReturnType<typeof listGroups>> = [];
  try {
    groups = await listGroups();
  } catch {
    groups = [];
  }

  // Compute catalogue-wide price extents and the unique colour list once.
  const allPrices: number[] = [];
  const colourSet = new Set<string>();
  for (const g of groups) {
    for (const v of g.variants) {
      if (v.priceGbp) {
        const p = Number.parseFloat(v.priceGbp);
        if (Number.isFinite(p)) allPrices.push(p);
      }
      if (v.colour) colourSet.add(v.colour);
    }
  }
  const priceMin = allPrices.length > 0 ? Math.floor(Math.min(...allPrices)) : 0;
  const priceMax = allPrices.length > 0 ? Math.ceil(Math.max(...allPrices)) : 100;
  const colourOptions = Array.from(colourSet).sort((a, b) => a.localeCompare(b));

  const breadcrumb = stringifyJsonLd(
    breadcrumbLd(baseUrl, [
      { name: 'Home', url: '/' },
      { name: 'Shop', url: '/shop' },
    ]),
  );

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: breadcrumb }}
      />

      <header className="space-y-2">
        <nav aria-label="Breadcrumb" className="text-sm text-[var(--brand-muted)]">
          <ol className="flex gap-1">
            <li>
              <a href="/" className="hover:underline">
                Home
              </a>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page">Shop</li>
          </ol>
        </nav>
        <h1
          className="text-3xl font-semibold tracking-tight md:text-4xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          The full range
        </h1>
        <p className="max-w-2xl text-base text-[var(--brand-muted)]">
          {groups.length === 0
            ? 'The catalogue is loading. Check back in a moment, or visit /healthz to see what the API is reporting.'
            : 'Each lamp comes in two or three colourways. Pick a colour, filter by price, the rest is just light.'}
        </p>
      </header>

      <div className="mt-8">
        <CatalogueGrid
          groups={groups}
          priceMin={priceMin}
          priceMax={priceMax}
          colourOptions={colourOptions}
        />
      </div>
    </>
  );
}
