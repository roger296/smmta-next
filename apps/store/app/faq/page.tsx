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
    'How long does delivery take, where do we ship, what is the returns policy, and which dimmers work — straight answers for every Filament Store lamp.',
  alternates: { canonical: '/faq' },
  openGraph: {
    type: 'website',
    url: '/faq',
    title: 'Shipping, returns & FAQ | Filament Store',
    description:
      'Delivery times, returns policy, dimmer compatibility, warranty, and other questions about Filament Store lamps.',
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

      <header className="mt-4 space-y-2">
        <h1
          className="text-3xl font-semibold tracking-tight md:text-4xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Frequently asked
        </h1>
        <p className="max-w-2xl text-base text-[var(--brand-muted)]">
          Shipping, returns, dimmer compatibility, and the practical bits.
          If your question isn&rsquo;t here, email{' '}
          <a
            href="mailto:orders@filament.shop"
            className="text-[var(--brand-ink)] underline-offset-2 hover:underline"
          >
            orders@filament.shop
          </a>
          .
        </p>
      </header>

      <section
        aria-labelledby="faq-list"
        className="mt-8 max-w-2xl space-y-3"
      >
        <h2 id="faq-list" className="sr-only">
          Questions
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
