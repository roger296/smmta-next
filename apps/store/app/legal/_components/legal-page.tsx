/**
 * Shared chrome for the legal pages (/legal/terms, /legal/returns,
 * /legal/privacy): breadcrumb, title block, "last updated" stamp and a
 * prose container tuned to the brand's typography.
 *
 * Legal copy is long-form reading, so the measure is capped at ~65ch and the
 * body colour is the muted token with headings in ink — the same hierarchy the
 * FAQ uses, so the pages don't feel bolted on.
 */
import Link from 'next/link';
import { LEGAL } from '@/lib/legal';

export function LegalPage({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm text-[var(--brand-muted)]">
        <ol className="flex flex-wrap gap-1">
          <li>
            <Link href="/" className="hover:underline">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{title}</li>
        </ol>
      </nav>

      <header className="mt-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          {eyebrow}
        </p>
        <h1
          className="text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {title}
        </h1>
        <p className="max-w-2xl text-base text-[var(--brand-muted)]">{intro}</p>
        <p className="text-xs uppercase tracking-wider text-[var(--brand-muted)]">
          Last updated {LEGAL.lastUpdated}
        </p>
      </header>

      <div className="legal-prose mt-10 max-w-2xl space-y-8 text-sm leading-relaxed text-[var(--brand-muted)]">
        {children}
      </div>
    </>
  );
}

/** One numbered section of a legal document. */
export function LegalSection({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2
        id={id}
        className="text-lg font-semibold text-[var(--brand-ink)]"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {heading}
      </h2>
      {children}
    </section>
  );
}
