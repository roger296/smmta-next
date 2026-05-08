/**
 * /faq — frequently asked questions.
 *
 * Crawler-friendly: visible markup + FAQPage JSON-LD share the same
 * data source so they can never drift. Indexable, in the sitemap, and
 * the same answers appear on every group page below the fold.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { faqPageLd, stringifyJsonLd } from '@/lib/seo/structured-data';
import { SHIPPING_FAQ } from '@/lib/seo/faq-data';

export const revalidate = 86_400; // 1 day — the FAQ rarely changes

export const metadata: Metadata = {
  title: 'Shipping, returns & FAQ',
  description:
    'Delivery times, returns policy, materials, tolerances, packaging — straight answers about Filament Store 3D printer filament.',
  alternates: { canonical: '/faq' },
  openGraph: {
    type: 'website',
    url: '/faq',
    title: 'Shipping, returns & FAQ | Filament Store',
    description:
      'Delivery times, returns, supported materials, diameter, tolerances, and other questions about Filament Store filament.',
  },
  robots: { index: true, follow: true },
};

export default function FaqPage() {
  const faqJson = stringifyJsonLd(faqPageLd(SHIPPING_FAQ));

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: faqJson }}
      />

      <nav aria-label="Breadcrumb" className="text-sm text-[var(--brand-muted)]">
        <ol className="flex flex-wrap gap-1">
          <li>
            <Link href="/" className="hover:underline">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">FAQ</li>
        </ol>
      </nav>

      <header className="mt-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          Frequently asked
        </p>
        <h1
          className="text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          The practical bits.
        </h1>
        <p className="max-w-2xl text-base text-[var(--brand-muted)]">
          Shipping, returns, materials, tolerances, packaging.
          If your question isn&rsquo;t here, email{' '}
          <a
            href="mailto:orders@filament.shop.cleverdeals.net"
            className="text-[var(--brand-ink)] underline-offset-2 hover:underline"
          >
            orders@filament.shop.cleverdeals.net
          </a>
          .
        </p>
      </header>

      <section
        aria-labelledby="faq-list"
        className="mt-10 max-w-2xl"
      >
        <h2 id="faq-list" className="sr-only">
          Questions
        </h2>
        <ul className="divide-y divide-[var(--brand-border)] border-y border-[var(--brand-border)]">
          {SHIPPING_FAQ.map((entry) => (
            <li key={entry.question} className="py-5">
              <h3 className="text-base font-semibold">{entry.question}</h3>
              <p
                className="mt-2 text-sm leading-relaxed text-[var(--brand-muted)]"
                // The answer text contains a few HTML entities (&rsquo;,
                // &ldquo;) baked into the source so the visible copy +
                // the JSON-LD payload share one canonical string.
                dangerouslySetInnerHTML={{ __html: entry.answer }}
              />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
