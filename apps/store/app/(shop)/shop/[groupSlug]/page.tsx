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
import { SwatchPicker } from '../../_components/swatch-picker';

export const revalidate = 60;

interface RouteParams {
  groupSlug: string;
}

const SHIPPING_FAQ = [
  {
    question: 'How long does delivery take?',
    answer:
      'Orders ship from our UK workshop within 1–2 working days. Standard tracked delivery arrives next-day in most of the UK; remote postcodes can take an extra day.',
  },
  {
    question: 'Do you ship outside the UK?',
    answer:
      'EU shipping is available at checkout. Duties and import VAT are payable on arrival per your country&rsquo;s rules.',
  },
  {
    question: 'What&rsquo;s your returns policy?',
    answer:
      'Unused lamps can be returned within 30 days for a full refund. Email orders@filament.shop and we&rsquo;ll send you a prepaid label.',
  },
  {
    question: 'Are the lamps dimmable?',
    answer:
      'Yes — every lamp in the range is dimmable on any standard trailing-edge dimmer. Old leading-edge dimmers may need replacing for flicker-free operation.',
  },
];

export async function generateStaticParams(): Promise<RouteParams[]> {
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
    throw err;
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
