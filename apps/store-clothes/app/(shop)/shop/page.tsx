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
    'Friendly clothes in real sizes — browse the whole range, filter by colour and price, pick what fits.',
  alternates: { canonical: '/shop' },
  openGraph: {
    type: 'website',
    url: '/shop',
    title: 'Shop | Clothes Shop',
    description: 'The full Clothes Shop range — every colour, every size.',
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

      <header className="space-y-3">
        <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-wider text-[var(--brand-muted)]">
          <ol className="flex gap-2">
            <li>
              <a href="/" className="hover:text-[var(--brand-ink)] transition-colors">
                Home
              </a>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-[var(--brand-ink)]">Shop</li>
          </ol>
        </nav>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          The full range
        </p>
        <h1
          className="text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Every colour, every size.
        </h1>
        <p className="max-w-2xl text-base text-[var(--brand-muted)]">
          {groups.length === 0
            ? 'The catalogue is loading. Check back in a moment.'
            : 'Browse every range, filter by colour or price. Real sizes, friendly fits, fast UK delivery from our supplier partners.'}
        </p>
      </header>

      <div className="mt-10">
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
