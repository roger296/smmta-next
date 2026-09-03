/**
 * /about — who we are, where we are, how to reach us.
 *
 * The audit's point: for a new domain asking for card details, "who are
 * you and where are you" is a purchase question, and the only answer on
 * the site was footer small print with a mailto link. This page carries
 * the company details in full, a real contact route, and the workshop
 * story that earns links — and gives the Organization schema in the root
 * layout something to point at.
 *
 * All company facts come from `lib/legal.ts` so they can't drift from
 * the footer or the legal pages.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL } from '@/lib/legal';
import { breadcrumbLd, stringifyJsonLd } from '@/lib/seo/structured-data';
import { getEnv } from '@/lib/env';

export const metadata: Metadata = {
  title: 'About',
  description:
    'Filament Store is a UK filament specialist run by TBV Limited. Who we are, where we ship from, and how to reach a human.',
  alternates: { canonical: '/about' },
  openGraph: {
    type: 'website',
    url: '/about',
    title: 'About | Filament Store',
    description: 'A UK filament specialist. Company details, contact, and how we work.',
  },
  robots: { index: true, follow: true },
};

export default function AboutPage() {
  const env = getEnv();
  const baseUrl = (() => {
    try {
      return new URL(env.STORE_BASE_URL);
    } catch {
      return new URL('http://localhost:3000');
    }
  })();

  const breadcrumb = stringifyJsonLd(
    breadcrumbLd(baseUrl, [
      { name: 'Home', url: '/' },
      { name: 'About', url: '/about' },
    ]),
  );

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: breadcrumb }}
      />

      <nav
        aria-label="Breadcrumb"
        className="text-xs uppercase tracking-wider text-[var(--brand-muted)]"
      >
        <ol className="flex gap-2">
          <li>
            <Link href="/" className="transition-colors hover:text-[var(--brand-ink)]">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-[var(--brand-ink)]">
            About
          </li>
        </ol>
      </nav>

      <header className="mt-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          About
        </p>
        <h1
          className="text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          A filament shop run by people who print.
        </h1>
        <p className="max-w-2xl text-base text-[var(--brand-muted)]">
          We stock one diameter, in depth, and we hold it in a UK warehouse so it ships the
          same day. That&rsquo;s the whole proposition.
        </p>
      </header>

      <section className="mt-12 max-w-2xl space-y-5 text-base leading-relaxed">
        <h2 className="text-2xl font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
          How we work
        </h2>
        <p>
          Every spool we sell is 1.75mm and 1kg. That&rsquo;s not a limitation we&rsquo;re
          apologising for — it&rsquo;s what the vast majority of FDM printers take, and
          carrying one diameter properly beats carrying three badly. It means the colour you
          want is more likely to be on the shelf, and that the shelf is in Britain rather than
          on a boat.
        </p>
        <p>
          Filament arrives vacuum-sealed with a desiccant pack and stays that way until you
          open it. The spools are cardboard on most ranges — recyclable, and they fit the same
          mounts as plastic. Orders placed before 2pm ship the same working day.
        </p>
        <p>
          We don&rsquo;t run flash sales, we don&rsquo;t take payment for placement in our own
          listings, and we don&rsquo;t print a &ldquo;was&rdquo; price next to a number that
          was never charged. The price on the page is the price you pay, including VAT.
        </p>

        <h2
          className="pt-4 text-2xl font-semibold"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Talk to us
        </h2>
        <p>
          One mailbox, read by the people who pack the orders:{' '}
          <a
            href={`mailto:${LEGAL.contactEmail}`}
            className="font-semibold text-[var(--brand-accent)] underline-offset-2 hover:underline"
          >
            {LEGAL.contactEmail}
          </a>
          . Include your order number if you have one and you&rsquo;ll get a faster answer.
          We aim to reply within one working day.
        </p>
        <p className="text-sm text-[var(--brand-muted)]">
          For delivery times, returns and the rest of the practical detail, the{' '}
          <Link href="/faq" className="text-[var(--brand-ink)] underline-offset-2 hover:underline">
            FAQ
          </Link>{' '}
          is the fastest route — it answers most of what reaches the inbox.
        </p>
      </section>

      <section className="mt-12 max-w-2xl">
        <h2
          className="text-2xl font-semibold"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Company details
        </h2>
        <dl className="mt-5 divide-y divide-[var(--brand-border)] border-y border-[var(--brand-border)] text-sm">
          <div className="grid grid-cols-[9rem_1fr] gap-4 py-3">
            <dt className="text-[var(--brand-muted)]">Trading name</dt>
            <dd>
              {LEGAL.storeName ?? 'Filament Store'}, a {LEGAL.parentName} brand
            </dd>
          </div>
          <div className="grid grid-cols-[9rem_1fr] gap-4 py-3">
            <dt className="text-[var(--brand-muted)]">Registered company</dt>
            <dd>{LEGAL.legalEntity}</dd>
          </div>
          <div className="grid grid-cols-[9rem_1fr] gap-4 py-3">
            <dt className="text-[var(--brand-muted)]">Company number</dt>
            <dd className="font-mono">{LEGAL.companyNumber}</dd>
          </div>
          <div className="grid grid-cols-[9rem_1fr] gap-4 py-3">
            <dt className="text-[var(--brand-muted)]">Registered office</dt>
            <dd>{LEGAL.registeredAddress}</dd>
          </div>
          {LEGAL.vatNumber && (
            <div className="grid grid-cols-[9rem_1fr] gap-4 py-3">
              <dt className="text-[var(--brand-muted)]">VAT number</dt>
              <dd className="font-mono">{LEGAL.vatNumber}</dd>
            </div>
          )}
          <div className="grid grid-cols-[9rem_1fr] gap-4 py-3">
            <dt className="text-[var(--brand-muted)]">Contact</dt>
            <dd>
              <a
                href={`mailto:${LEGAL.contactEmail}`}
                className="text-[var(--brand-accent)] underline-offset-2 hover:underline"
              >
                {LEGAL.contactEmail}
              </a>
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-[var(--brand-muted)]">
          Returns are sent to a different address from the registered office — please request
          a returns reference first so your parcel can be matched to its order. See the{' '}
          <Link
            href="/legal/returns"
            className="text-[var(--brand-ink)] underline-offset-2 hover:underline"
          >
            returns policy
          </Link>
          .
        </p>
      </section>
    </>
  );
}
