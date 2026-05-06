/**
 * Home (`/`). RSC, revalidate 300s.
 *
 *   - Hero: filament-store-positioned headline + the technical specs that
 *     read as confident-without-shouting in the industrial brand
 *   - Featured ranges grid (uses the published catalogue, up to 6 items)
 *   - Brand story block — "made for makers", workshop angle, no flash sales
 *   - JSON-LD: Organization (sitewide, from layout) + WebSite + SearchAction
 */
import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import { listGroups } from '@/lib/smmta';
import { getEnv } from '@/lib/env';
import { priceFromString, stringifyJsonLd, websiteLd } from '@/lib/seo/structured-data';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Premium 3D Printer Filament — PLA, PETG, ABS, ASA, TPU',
  description:
    'PLA, PETG, ABS, ASA, and TPU 3D printer filament — 1.75mm, 1kg spools, ±0.02mm tolerance. Vacuum-sealed, fast UK delivery, fair prices.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    title: 'Filament Store — Premium 3D Printer Filament',
    description:
      'PLA, PETG, ABS, ASA, and TPU 3D printer filament — tight tolerances, fast UK delivery.',
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
  // Up to 6 featured ranges — fills two rows on a 3-up grid for visual weight
  // on a workshop-style home page.
  const featured = groups.slice(0, 6);

  const websiteJsonLd = stringifyJsonLd(websiteLd(baseUrl));

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: websiteJsonLd }}
      />

      {/* Hero */}
      <section className="space-y-6 border-b border-[var(--brand-border)] pb-16">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          1.75mm · 1kg · vacuum-sealed
        </p>
        <h1
          className="max-w-4xl text-5xl font-bold leading-[1.05] tracking-tight md:text-7xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Filament that prints first time.
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-[var(--brand-muted)]">
          PLA, PETG, ABS, ASA, and TPU from Landau. Tight tolerances, vacuum-sealed
          cardboard spools, same-day dispatch from our UK warehouse on orders
          before 2pm.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Link
            href="/shop"
            className="inline-block bg-[var(--brand-ink)] px-7 py-4 text-sm font-semibold uppercase tracking-wider text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)]"
          >
            Browse the range
          </Link>
          <Link
            href="/faq"
            className="inline-block border border-[var(--brand-border)] px-7 py-4 text-sm font-semibold uppercase tracking-wider transition-colors hover:border-[var(--brand-ink)]"
          >
            Print specs &amp; FAQ
          </Link>
        </div>
      </section>

      {/* Featured ranges */}
      {featured.length > 0 && (
        <section className="mt-20 space-y-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
                Materials
              </p>
              <h2
                className="text-3xl font-bold tracking-tight md:text-4xl"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Choose your filament.
              </h2>
            </div>
            <Link
              href="/shop"
              className="text-sm font-semibold uppercase tracking-wider text-[var(--brand-accent)] hover:underline"
            >
              View all ranges →
            </Link>
          </div>

          {/*
            Grid implemented as a 1px-gap arrangement on a steel-coloured
            backdrop — the gap itself becomes the divider, no card borders
            needed. Reads clean and "spec-sheet" in the industrial brand.
          */}
          <ul className="grid gap-px bg-[var(--brand-border)] sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((g) => (
              <li key={g.id} className="bg-[var(--brand-paper)]">
                <FeaturedCard group={g} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Brand story */}
      <section
        className="mt-24 grid max-w-5xl gap-12 md:grid-cols-2 md:gap-16"
        aria-labelledby="brand-story"
      >
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
            Made for makers
          </p>
          <h2
            id="brand-story"
            className="text-3xl font-bold tracking-tight md:text-4xl"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            A workshop in the UK. Filament that prints first time.
          </h2>
        </div>
        <div className="space-y-4 text-base leading-relaxed text-[var(--brand-muted)]">
          <p>
            We hold stock of every standard 3D printer filament — five materials, dozens of
            colours. Vacuum-sealed in cardboard boxes (recyclable, like the spools).
          </p>
          <p>
            Orders before 2pm ship same day from our UK warehouse. No flash sales, no
            sponsored placements, no made-up &ldquo;was&rdquo; prices. The price you see is
            the price you pay.
          </p>
        </div>
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
      className="group block h-full transition-colors hover:bg-[var(--brand-bone)]"
    >
      <div className="aspect-square overflow-hidden bg-[var(--brand-bone)]">
        {group.heroImageUrl ? (
          <Image
            src={group.heroImageUrl}
            alt={group.name}
            width={800}
            height={800}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs uppercase tracking-wider text-[var(--brand-muted)]">
            No image
          </div>
        )}
      </div>
      <div className="space-y-2 p-5">
        <h3 className="text-base font-semibold leading-snug">{group.name}</h3>
        {group.shortDescription && (
          <p className="line-clamp-2 text-sm text-[var(--brand-muted)]">
            {group.shortDescription}
          </p>
        )}
        {priceFrom && (
          <p className="pt-1 text-sm font-semibold text-[var(--brand-accent)]">
            From {priceFrom}
          </p>
        )}
      </div>
    </Link>
  );
}
