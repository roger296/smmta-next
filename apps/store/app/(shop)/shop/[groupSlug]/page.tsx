/**
 * Group page (`/shop/[groupSlug]`). RSC, fully dynamic at runtime, with a
 * 60-second revalidate window for cache hits. Not statically generated at
 * build time — see the `dynamic = 'force-dynamic'` block below for why.
 *
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
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { listGroups, getGroupBySlug, SmmtaApiError } from '@/lib/smmta';
import { getEnv } from '@/lib/env';
import { ogImageUrl } from '@/lib/seo/og-image';
import {
  breadcrumbLd,
  faqPageLd,
  groupProductLd,
  stringifyJsonLd,
} from '@/lib/seo/structured-data';
import { Markdown } from '@/lib/markdown';
import { rangeCopyFor } from '@/lib/range-copy';
import { SHIPPING_FAQ } from '@/lib/seo/faq-data';

/** How many FAQ entries a product page repeats before linking to /faq. */
const PRODUCT_PAGE_FAQ_COUNT = 3;
import { pageTitle, socialTitle } from '@/lib/seo/title';
import { SwatchPicker } from '../../_components/swatch-picker';
import { YouMayAlsoLike } from '../../_components/you-may-also-like';

// `output: 'standalone'` + dynamic route + `generateStaticParams` returning
// `[]` is a footgun: Next.js's standalone runtime treats the empty list as
// "this is the exhaustive set of valid slugs" and answers any other request
// with `NoFallbackError` (see store.log on the failing CI run). We don't
// pre-render any group slugs at build time (the build doesn't have a
// reliable API to call), so the route is fully dynamic. `force-dynamic`
// removes the static-generation pipeline entirely and the standalone
// runtime renders on every request.
export const dynamic = 'force-dynamic';
export const dynamicParams = true;
export const revalidate = 60;

interface RouteParams {
  groupSlug: string;
}


export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { groupSlug } = await params;
  try {
    const group = await getGroupBySlug(groupSlug);
    const ogBase = (() => {
      try {
        return new URL(getEnv().STORE_BASE_URL);
      } catch {
        return new URL('http://localhost:3000');
      }
    })();
    const ogImage = ogImageUrl(group.heroImageUrl, ogBase);
    return {
      title: pageTitle(group.seoTitle, group.name),
      description: group.seoDescription ?? group.shortDescription ?? undefined,
      keywords: group.seoKeywords ?? undefined,
      alternates: { canonical: `/shop/${group.slug ?? groupSlug}` },
      robots: { index: true, follow: true },
      openGraph: {
        // No `type` here — a group page is a product page, so it wants
        // og:type=product, which Next's typed union can't express. It's
        // rendered as a real <meta property> in the component body; see
        // the note there. Setting 'website' here would emit a second,
        // contradictory og:type.
        url: `/shop/${group.slug ?? groupSlug}`,
        title: socialTitle(group.seoTitle, group.name),
        description: group.seoDescription ?? group.shortDescription ?? undefined,
        images: ogImage ? [ogImage] : undefined,
      },
      twitter: {
        card: 'summary_large_image',
        title: socialTitle(group.seoTitle, group.name),
        description: group.seoDescription ?? group.shortDescription ?? undefined,
        images: ogImage ? [ogImage] : undefined,
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
  // SEO 09: the identical nine-question FAQ was rendered verbatim on all
  // 17 product pages — roughly 450 words against ~60 words of unique
  // product copy, making every product page about 88% text that also
  // appears on sixteen others. Three product-relevant questions stay
  // (they answer real purchase objections at the point of decision); the
  // rest is one click away on /faq.
  //
  // The JSON-LD still describes only what's visible on THIS page, so the
  // markup and the rendered content can't drift apart.
  const rangeCopy = rangeCopyFor(group.slug ?? groupSlug);
  const productFaq = SHIPPING_FAQ.slice(0, PRODUCT_PAGE_FAQ_COUNT);
  const faqJson = stringifyJsonLd(faqPageLd(productFaq));

  return (
    <>
      {/* Real <meta property> — Next's metadata API can only emit
          `name=` for keys outside its typed OpenGraph union, and Open
          Graph consumers read `property=`. See the note in
          generateMetadata. */}
      <meta property="og:type" content="product" />
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

      <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-wider text-[var(--brand-muted)]">
        <ol className="flex flex-wrap gap-2">
          <li>
            <a href="/" className="hover:text-[var(--brand-ink)] transition-colors">
              Home
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <a href="/shop" className="hover:text-[var(--brand-ink)] transition-colors">
              Shop
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-[var(--brand-ink)]">{group.name}</li>
        </ol>
      </nav>

      <SwatchPicker groupName={group.name} variants={group.variants} />

      {/*
        SEO 09: unique per-range copy.

        The page previously carried ~32 words of its own — a templated
        "premium 3D printer filament" sentence — which told a buyer
        nothing about why this range costs what it does versus the one
        below it, and gave Google nothing distinguishing to rank. The
        text lives in lib/range-copy.ts rather than the description
        column because that column is regenerated by the seed script,
        so copy stored there can be silently overwritten.
      */}
      {rangeCopy && (
        <section className="mt-12 max-w-2xl border-t border-[var(--brand-border)] pt-10">
          <h2
            className="text-2xl font-semibold"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            About this range
          </h2>
          <p className="mt-3 text-base font-medium">{rangeCopy.summary}</p>
          <div className="mt-4 space-y-4 text-base leading-relaxed">
            {rangeCopy.body.map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>

          <div className="mt-8 grid gap-px border border-[var(--brand-border)] bg-[var(--brand-border)] sm:grid-cols-2">
            <div className="bg-[var(--brand-paper)] p-5">
              <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-accent)]">
                Good for
              </h3>
              <ul className="mt-3 space-y-1.5 text-sm">
                {rangeCopy.bestFor.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="bg-[var(--brand-paper)] p-5">
              <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-muted)]">
                Not for
              </h3>
              <ul className="mt-3 space-y-1.5 text-sm text-[var(--brand-muted)]">
                {rangeCopy.notFor.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>

          <p className="mt-5 text-sm">
            <Link
              href={`/${rangeCopy.material}`}
              className="font-semibold text-[var(--brand-accent)] underline-offset-2 hover:underline"
            >
              Print settings and the full {rangeCopy.material.toUpperCase()} range →
            </Link>
          </p>
        </section>
      )}

      {group.longDescription && (
        <section className="mt-12 max-w-2xl border-t border-[var(--brand-border)] pt-10">
          <Markdown source={group.longDescription} />
        </section>
      )}

      <YouMayAlsoLike currentSlug={group.slug ?? groupSlug} groups={allGroups} />

      <section
        className="mt-20 max-w-2xl"
        aria-labelledby="shipping-faq"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          The practical bits
        </p>
        <h2
          id="shipping-faq"
          className="mt-2 text-3xl font-bold tracking-tight md:text-4xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Shipping &amp; returns.
        </h2>
        <ul className="mt-8 divide-y divide-[var(--brand-border)] border-y border-[var(--brand-border)]">
          {productFaq.map((entry) => (
            <li key={entry.question} className="py-5">
              <h3 className="text-base font-semibold">{entry.question}</h3>
              <p
                className="mt-2 text-sm leading-relaxed text-[var(--brand-muted)]"
                dangerouslySetInnerHTML={{ __html: entry.answer }}
              />
            </li>
          ))}
        </ul>
        <p className="mt-5 text-sm">
          <Link
            href="/faq"
            className="font-semibold text-[var(--brand-accent)] underline-offset-2 hover:underline"
          >
            All shipping, returns and material questions →
          </Link>
        </p>
      </section>
    </>
  );
}
