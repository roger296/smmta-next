/**
 * Group page (`/shop/[groupSlug]`). RSC, revalidate 60s.
 *
 *   - generateStaticParams from /storefront/groups
 *   - generateMetadata uses seo_title || name etc.
 *   - Variant swatch picker (client island) updates ?colour= without a full nav
 *   - Long description rendered from markdown via a strict allow-list
 *   - JSON-LD: Product + AggregateOffer for the group + BreadcrumbList
 *   - Below-the-fold: shipping FAQ block with FAQPage JSON-LD
 *
 * Group slug is the canonical URL — variant URLs use `?colour=` query rather
 * than a separate path, so search engines don't index colour permutations
 * as duplicate content.
 */
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { listGroups, getGroupBySlug, SmmtaApiError } from '@/lib/smmta';
import { getEnv } from '@/lib/env';
import {
  breadcrumbLd,
  faqPageLd,
  groupProductLd,
  stringifyJsonLd,
} from '@/lib/seo/structured-data';
import { Markdown } from '@/lib/markdown';
import { SHIPPING_FAQ } from '@/lib/seo/faq-data';
import { SwatchPicker } from '../../_components/swatch-picker';
import { YouMayAlsoLike } from '../../_components/you-may-also-like';

export const revalidate = 60;

interface RouteParams {
  groupSlug: string;
}

export async function generateStaticParams(): Promise<RouteParams[]> {
  // Pre-rendering at build time requires the SMMTA API to be reachable
  // from the build environment — and even when it is, *every* listed slug
  // gets prerendered, which means a single transient API failure during
  // prerender of one page kills the whole build (Next throws and the
  // page's own try/catch only swallows 404s).
  //
  // The page is RSC with `revalidate = 60`, so the first request renders
  // it and subsequent ones hit Next's route cache anyway — pre-rendering
  // at build is an optimisation, not a requirement. Default to off, gated
  // behind STOREFRONT_PRERENDER=1 for environments (local dev, staging
  // with a known-good API) that want the catalogue baked into the build.
  if (process.env.STOREFRONT_PRERENDER !== '1') {
    return [];
  }
  try {
    const groups = await listGroups();
    return groups
      .filter((g): g is typeof g & { slug: string } => Boolean(g.slug))
      .map((g) => ({ groupSlug: g.slug }));
  } catch {
    // If the API isn't up at build time, fall back to runtime SSR.
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { groupSlug } = await params;
  try {
    const group = await getGroupBySlug(groupSlug);
    return {
      title: group.seoTitle ?? group.name,
      description: group.seoDescription ?? group.shortDescription ?? undefined,
      keywords: group.seoKeywords ?? undefined,
      alternates: { canonical: `/shop/${group.slug ?? groupSlug}` },
      robots: { index: true, follow: true },
      openGraph: {
        type: 'website',
        url: `/shop/${group.slug ?? groupSlug}`,
        title: group.seoTitle ?? group.name,
        description: group.seoDescription ?? group.shortDescription ?? undefined,
        images: group.heroImageUrl ? [group.heroImageUrl] : undefined,
      },
      twitter: {
        card: 'summary_large_image',
        title: group.seoTitle ?? group.name,
        description: group.seoDescription ?? group.shortDescription ?? undefined,
        images: group.heroImageUrl ? [group.heroImageUrl] : undefined,
      },
    };
  } catch {
    return { title: 'Range', robots: { index: false, follow: true } };
  }
}

export default async function GroupPage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const { groupSlug } = await params;
  const env = getEnv();
  const baseUrl = (() => {
    try {
      return new URL(env.STORE_BASE_URL);
    } catch {
      return new URL('http://localhost:3000');
    }
  })();

  let group;
  try {
    group = await getGroupBySlug(groupSlug);
  } catch (err) {
    if (err instanceof SmmtaApiError && err.status === 404) {
      notFound();
    }
    // Re-throw at runtime so the user sees a 5xx and our error tracker
    // catches it; but during build-time prerender we don't want a single
    // API hiccup to fail the whole build. (`STOREFRONT_PRERENDER=1`
    // opts back into prerender; the rendered page would then 404.)
    if (process.env.NEXT_PHASE === 'phase-production-build') {
      notFound();
    }
    throw err;
  }

  // Side-load the catalogue for "you may also like". Failure mustn't
  // block the group page itself — the suggestion strip is a nice-to-have.
  let allGroups: Awaited<ReturnType<typeof listGroups>> = [];
  try {
    allGroups = await listGroups();
  } catch {
    allGroups = [];
  }

  const url = `/shop/${group.slug ?? groupSlug}`;
  const productJsonLd = stringifyJsonLd(groupProductLd(baseUrl, group, url));
  const breadcrumb = stringifyJsonLd(
    breadcrumbLd(baseUrl, [
      { name: 'Home', url: '/' },
      { name: 'Shop', url: '/shop' },
      { name: group.name, url },
    ]),
  );
  const faqJson = stringifyJsonLd(faqPageLd(SHIPPING_FAQ));

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: productJsonLd }}
      />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: breadcrumb }}
      />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: faqJson }}
      />

      <nav aria-label="Breadcrumb" className="text-sm text-[var(--brand-muted)]">
        <ol className="flex flex-wrap gap-1">
          <li>
            <a href="/" className="hover:underline">
              Home
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <a href="/shop" className="hover:underline">
              Shop
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{group.name}</li>
        </ol>
      </nav>

      <SwatchPicker groupName={group.name} variants={group.variants} />

      {group.longDescription && (
        <section className="mt-10 max-w-2xl">
          <Markdown source={group.longDescription} />
        </section>
      )}

      <YouMayAlsoLike currentSlug={group.slug ?? groupSlug} groups={allGroups} />

      <section
        className="mt-16 max-w-2xl space-y-4"
        aria-labelledby="shipping-faq"
      >
        <h2
          id="shipping-faq"
          className="text-2xl font-semibold tracking-tight"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Shipping &amp; returns
        </h2>
        <ul className="space-y-3">
          {SHIPPING_FAQ.map((entry) => (
            <li
              key={entry.question}
              className="rounded-[var(--radius)] border border-[var(--brand-border)] p-4"
            >
              <h3 className="font-medium">{entry.question}</h3>
              <p
                className="mt-1 text-sm text-[var(--brand-muted)]"
                dangerouslySetInnerHTML={{ __html: entry.answer }}
              />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
