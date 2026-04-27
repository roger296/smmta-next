/**
 * Home (`/`). RSC, revalidate 300s.
 *
 *   - Hero section
 *   - Featured groups grid (uses the published catalogue)
 *   - Brand story block
 *   - JSON-LD: Organization (sitewide, from layout) + WebSite + SearchAction (here)
 */
import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import { listGroups } from '@/lib/smmta';
import { getEnv } from '@/lib/env';
import { priceFromString, stringifyJsonLd, websiteLd } from '@/lib/seo/structured-data';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Hand-finished LED filament lighting',
  description:
    'A small, considered range of LED filament lamps. Designed in the UK, delivered in days, dimmable on any standard switch.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    title: 'Filament Store — Hand-finished LED filament lighting',
    description:
      'A small, considered range of LED filament lamps. Designed in the UK, delivered in days, dimmable on any standard switch.',
  },
};

export default async function HomePage() {
  const env = getEnv();
  const baseUrl = (() => {
    try {
      return new URL(env.STORE_BASE_URL);
    } catch {
      return new URL('http://localhost:3000');
    }
  })();

  // Failure here mustn't break the home page — render the hero + brand
  // story even if the catalogue read fails (5xx, dropped connection, etc.).
  let groups: Awaited<ReturnType<typeof listGroups>> = [];
  try {
    groups = await listGroups();
  } catch {
    groups = [];
  }
  const featured = groups.slice(0, 3);

  const websiteJsonLd = stringifyJsonLd(websiteLd(baseUrl));

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: websiteJsonLd }}
      />

      <section className="space-y-4">
        <h1
          className="text-4xl font-semibold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Light, hand-finished.
        </h1>
        <p className="max-w-2xl text-lg text-[var(--brand-muted)]">
          A small, considered range of LED filament lamps. Designed in the UK, delivered in days,
          dimmable on any standard trailing-edge switch.
        </p>
        <p>
          <Link
            href="/shop"
            className="inline-block rounded-[var(--radius)] bg-[var(--brand-ink)] px-6 py-3 text-base font-medium text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)]"
          >
            Browse the range
          </Link>
        </p>
      </section>

      {featured.length > 0 && (
        <section className="mt-16 space-y-6">
          <h2
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Featured ranges
          </h2>
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((g) => (
              <li key={g.id}>
                <FeaturedCard group={g} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        className="mt-16 max-w-2xl space-y-3 text-[var(--brand-muted)]"
        aria-labelledby="brand-story"
      >
        <h2
          id="brand-story"
          className="text-2xl font-semibold tracking-tight text-[var(--brand-ink)]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          A small workshop, a sharp focus.
        </h2>
        <p>
          We make a single product range, very well. Every lamp is hand-finished, dimmable on any
          standard trailing-edge dimmer, rated for 25,000 hours, and shipped from a small workshop
          in the UK.
        </p>
        <p>
          We don&rsquo;t do flash sales, sponsored placements, or made-up &ldquo;was&rdquo; prices.
          The price you see is the price.
        </p>
      </section>
    </>
  );
}

function FeaturedCard({
  group,
}: {
  group: Awaited<ReturnType<typeof listGroups>>[number];
}) {
  const href = group.slug ? `/shop/${group.slug}` : '/shop';
  const priceFrom = priceFromString(group);
  return (
    <Link
      href={href}
      className="group block overflow-hidden rounded-[var(--radius)] border border-[var(--brand-border)] transition-colors hover:border-[var(--brand-ink)]"
    >
      <div className="aspect-[4/5] overflow-hidden bg-[var(--brand-border)]">
        {group.heroImageUrl ? (
          <Image
            src={group.heroImageUrl}
            alt={group.name}
            width={800}
            height={1000}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--brand-muted)]">
            No image
          </div>
        )}
      </div>
      <div className="space-y-1 p-4">
        <h3 className="font-medium">{group.name}</h3>
        {group.shortDescription && (
          <p className="line-clamp-2 text-sm text-[var(--brand-muted)]">{group.shortDescription}</p>
        )}
        {priceFrom && <p className="text-sm font-medium">From {priceFrom}</p>}
      </div>
    </Link>
  );
}
