/**
 * Catalogue (`/shop`): the way into the range, by category.
 *
 * Lists the top-level categories with their subcategories, each linking to
 * its category page, which paginates and filters by size, colour, brand and
 * price on the server.
 *
 * This page used to render every range, with all its variants, in one client
 * filter grid. The drop-ship catalogues run to thousands of ranges and around
 * a hundred thousand variants, which is far too much to send to a browser.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { listCategories } from '@/lib/smmta';
import { getEnv } from '@/lib/env';
import { breadcrumbLd, stringifyJsonLd } from '@/lib/seo/structured-data';

// The category list is cached for five minutes by listCategories.
export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Shop',
  description:
    'Friendly clothes in real sizes — browse by category, filter by size, colour and price, pick what fits.',
  alternates: { canonical: '/shop' },
  openGraph: {
    type: 'website',
    url: '/shop',
    title: 'Shop | Clothes Shop',
    description: 'The full Clothes Shop range, by category — every colour, every size.',
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

  let categories: Awaited<ReturnType<typeof listCategories>> = [];
  try {
    categories = await listCategories();
  } catch {
    categories = [];
  }
  const visible = categories.filter((c) => Boolean(c.slug));

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
          Shop by category
        </p>
        <h1
          className="text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Every colour, every size.
        </h1>
        <p className="max-w-2xl text-base text-[var(--brand-muted)]">
          {visible.length === 0
            ? 'The catalogue is loading. Check back in a moment.'
            : 'Pick a category, then filter by size, colour and price. Real sizes, friendly fits, fast UK delivery from our supplier partners.'}
        </p>
      </header>

      {visible.length > 0 ? (
        <ul className="mt-10 grid gap-px bg-[var(--brand-border)] sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((c) => (
            <li key={c.slug} className="bg-[var(--brand-paper)]">
              <div className="flex h-full flex-col gap-3 p-6">
                <h2 className="text-xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
                  <Link href={`/shop/c/${c.slug}`} className="transition-colors hover:text-[var(--brand-accent)]">
                    {c.name}
                  </Link>
                </h2>
                {c.description ? (
                  <p className="text-sm text-[var(--brand-muted)]">{c.description}</p>
                ) : null}
                {c.children.length > 0 ? (
                  <ul className="flex flex-wrap gap-2 text-sm">
                    {c.children
                      .filter((s) => Boolean(s.slug))
                      .map((s) => (
                        <li key={s.slug}>
                          <Link
                            href={`/shop/c/${c.slug}/${s.slug}`}
                            className="inline-block rounded-[var(--radius-pill)] border border-[var(--brand-border)] px-3 py-1 transition-colors hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)]"
                          >
                            {s.name}
                          </Link>
                        </li>
                      ))}
                  </ul>
                ) : null}
                <Link
                  href={`/shop/c/${c.slug}`}
                  className="mt-auto pt-2 text-sm font-semibold text-[var(--brand-accent)] hover:underline"
                >
                  Shop all {c.name} →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
