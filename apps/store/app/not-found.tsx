import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * 404 page.
 *
 * The explicit `metadata` export is the point of this file. Without it,
 * Next's built-in not-found boundary rendered inside the root layout and
 * the document carried BOTH sets of tags — two <title> elements and
 * `robots: noindex` immediately followed by `robots: index, follow`.
 * Google resolves that safely (most restrictive wins) but it's a real
 * signal that layout metadata is leaking somewhere it shouldn't.
 */
export const metadata: Metadata = {
  title: 'Page not found',
  description: 'That page does not exist. Browse the filament range instead.',
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <section className="mx-auto max-w-xl space-y-5 py-16 text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
        404
      </p>
      <h1
        className="text-4xl font-bold tracking-tight md:text-5xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        We can&rsquo;t find that page.
      </h1>
      <p className="text-base text-[var(--brand-muted)]">
        It may have moved, or the link may be wrong. The whole range is two clicks away.
      </p>
      <div className="flex flex-wrap justify-center gap-3 pt-2">
        <Link
          href="/shop"
          className="inline-block bg-[var(--brand-ink)] px-7 py-4 text-sm font-semibold uppercase tracking-wider text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)]"
        >
          Browse the range
        </Link>
        <Link
          href="/faq"
          className="inline-block border border-[var(--brand-border)] px-7 py-4 text-sm font-semibold uppercase tracking-wider transition-colors hover:bg-[var(--brand-bone)]"
        >
          Shipping &amp; FAQ
        </Link>
      </div>
    </section>
  );
}
