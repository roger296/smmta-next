/**
 * Material category page — `/pla`, `/petg`, `/abs`, `/asa`, `/tpu`.
 *
 * The page type every UK competitor ranks with and this site didn't
 * have. "PETG filament UK" carries far more volume than any product
 * name, because nobody searches "Landau PETG Pro" until they already
 * know us — and there was no page whose job was to answer it.
 *
 * `dynamicParams = false` means anything that isn't one of the five
 * materials 404s at the routing layer rather than in this component.
 * That matters because this is a root-level dynamic segment: static
 * routes like /about and /faq take precedence in Next's matcher, and
 * everything else falls through to a clean 404 rather than rendering an
 * empty category.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listGroups } from '@/lib/smmta';
import { getEnv } from '@/lib/env';
import { MATERIALS, findMaterial, groupMatchesMaterial } from '@/lib/materials';
import { breadcrumbLd, itemListLd, stringifyJsonLd } from '@/lib/seo/structured-data';
import { CatalogueGrid } from '../_components/catalogue-grid';

export const dynamic = 'force-dynamic';
export const dynamicParams = false;

export function generateStaticParams() {
  return MATERIALS.map((m) => ({ material: m.slug }));
}

interface RouteParams {
  material: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { material } = await params;
  const def = findMaterial(material);
  if (!def) return { title: 'Not found', robots: { index: false, follow: true } };
  return {
    title: def.title,
    description: def.description,
    alternates: { canonical: `/${def.slug}` },
    openGraph: {
      type: 'website',
      url: `/${def.slug}`,
      title: `${def.title} | Filament Store`,
      description: def.description,
    },
    robots: { index: true, follow: true },
  };
}

export default async function MaterialPage({ params }: { params: Promise<RouteParams> }) {
  const { material } = await params;
  const def = findMaterial(material);
  if (!def) notFound();

  const env = getEnv();
  const baseUrl = (() => {
    try {
      return new URL(env.STORE_BASE_URL);
    } catch {
      return new URL('http://localhost:3000');
    }
  })();

  let allGroups: Awaited<ReturnType<typeof listGroups>> = [];
  try {
    allGroups = await listGroups();
  } catch {
    allGroups = [];
  }
  const groups = allGroups.filter((g) => groupMatchesMaterial(g.name, def.code));

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
      { name: def.name, url: `/${def.slug}` },
    ]),
  );
  const itemList = stringifyJsonLd(
    itemListLd(
      baseUrl,
      groups
        .filter((g) => g.slug)
        .map((g) => ({ name: g.name, url: `/shop/${g.slug}` })),
    ),
  );

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: breadcrumb }}
      />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: itemList }}
      />

      <nav
        aria-label="Breadcrumb"
        className="text-xs uppercase tracking-wider text-[var(--brand-muted)]"
      >
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link href="/" className="transition-colors hover:text-[var(--brand-ink)]">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href="/shop" className="transition-colors hover:text-[var(--brand-ink)]">
              Shop
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-[var(--brand-ink)]">
            {def.name}
          </li>
        </ol>
      </nav>

      <header className="mt-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          Material
        </p>
        <h1
          className="text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {def.title}
        </h1>
        <p className="max-w-2xl text-base text-[var(--brand-muted)]">{def.standfirst}</p>
      </header>

      {/* Settings card — the thing a returning customer actually came for,
          so it sits above the fold rather than under the essay. */}
      <dl className="mt-8 grid grid-cols-2 gap-px border border-[var(--brand-border)] bg-[var(--brand-border)] sm:grid-cols-3 lg:grid-cols-5">
        {def.settings.map((s) => (
          <div key={s.label} className="bg-[var(--brand-bone)] p-4">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--brand-muted)]">
              {s.label}
            </dt>
            <dd className="mt-1 text-sm font-semibold">{s.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-[var(--brand-muted)]">
        Starting values — adjust to your own printer and conditions.
      </p>

      <section className="mt-12">
        <h2
          className="text-2xl font-semibold"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {groups.length > 0
            ? `${def.name} in stock`
            : `${def.name} is not currently ranged`}
        </h2>
        <div className="mt-6">
          {groups.length > 0 ? (
            <CatalogueGrid
              groups={groups}
              priceMin={priceMin}
              priceMax={priceMax}
              colourOptions={colourOptions}
            />
          ) : (
            <p className="border-y border-[var(--brand-border)] py-10 text-center text-sm text-[var(--brand-muted)]">
              Nothing in this material right now.{' '}
              <Link href="/shop" className="text-[var(--brand-accent)] hover:underline">
                Browse the full range
              </Link>
              .
            </p>
          )}
        </div>
      </section>

      <div className="mt-16 max-w-2xl space-y-10">
        {def.sections.map((section) => (
          <section key={section.heading} className="space-y-4">
            <h2
              className="text-2xl font-semibold"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {section.heading}
            </h2>
            {section.body.map((para, i) => (
              <p key={i} className="text-base leading-relaxed">
                {para}
              </p>
            ))}
          </section>
        ))}
      </div>

      <nav aria-label="Other materials" className="mt-16 border-t border-[var(--brand-border)] pt-8">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          Other materials
        </h2>
        <ul className="mt-4 flex flex-wrap gap-3">
          {MATERIALS.filter((m) => m.slug !== def.slug).map((m) => (
            <li key={m.slug}>
              <Link
                href={`/${m.slug}`}
                className="inline-flex min-h-11 items-center border border-[var(--brand-border)] px-4 text-sm font-semibold uppercase tracking-wider transition-colors hover:bg-[var(--brand-bone)]"
              >
                {m.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
