/**
 * Site footer — emits internal links to every published group plus the
 * static legal / FAQ pages. Surfacing the group list here gives every
 * page in the storefront a crawlable link to every category, which
 * helps with internal-link equity and is one of the cheapest SEO
 * wins available.
 *
 * Server component; reads `listGroups` directly. Failures fall back to
 * a footer with no category links so the page still renders.
 *
 * The "Powered by CleverDeals" link in the bottom strip acknowledges
 * the parent retailer relationship without requiring the storefront's
 * visual identity to inherit CleverDeals' yellow-on-black palette.
 */
import Link from 'next/link';
import { listGroups } from '@/lib/smmta';

const STORE_NAME = 'Filament Store';
const ABOUT_BLURB =
  'Premium 3D printer filament for makers, hobbyists, and engineers. PLA, PETG, ABS, ASA, and TPU — vacuum-sealed, tight tolerances, fast UK delivery.';

export async function SiteFooter() {
  let groups: Awaited<ReturnType<typeof listGroups>> = [];
  try {
    groups = await listGroups();
  } catch {
    groups = [];
  }
  // Match the catalogue's sortOrder, then alphabetise as a stable
  // tie-break so the footer order is deterministic across renders.
  const sorted = [...groups].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });

  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-[var(--brand-border)] bg-[var(--brand-bone)] py-12 text-sm text-[var(--brand-muted)]">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 md:grid-cols-4">
        <section aria-labelledby="footer-shop">
          <h2
            id="footer-shop"
            className="mb-4 text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]"
          >
            Shop
          </h2>
          <ul className="space-y-2">
            <li>
              <Link
                href="/shop"
                className="transition-colors hover:text-[var(--brand-ink)]"
              >
                All ranges
              </Link>
            </li>
            {sorted
              .filter((g): g is typeof g & { slug: string } => Boolean(g.slug))
              .map((g) => (
                <li key={g.id}>
                  <Link
                    href={`/shop/${g.slug}`}
                    className="transition-colors hover:text-[var(--brand-ink)]"
                  >
                    {g.name}
                  </Link>
                </li>
              ))}
          </ul>
        </section>

        <section aria-labelledby="footer-help">
          <h2
            id="footer-help"
            className="mb-4 text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]"
          >
            Help
          </h2>
          <ul className="space-y-2">
            <li>
              <Link
                href="/faq"
                className="transition-colors hover:text-[var(--brand-ink)]"
              >
                Shipping &amp; FAQ
              </Link>
            </li>
            <li>
              <Link
                href="/legal/returns"
                className="transition-colors hover:text-[var(--brand-ink)]"
              >
                Returns &amp; cancellations
              </Link>
            </li>
            <li>
              <Link
                href="/legal/terms"
                className="transition-colors hover:text-[var(--brand-ink)]"
              >
                Terms &amp; conditions
              </Link>
            </li>
            <li>
              <Link
                href="/legal/privacy"
                className="transition-colors hover:text-[var(--brand-ink)]"
              >
                Privacy policy
              </Link>
            </li>
            <li>
              <a
                href="mailto:orders@filament.cleverdeals.net"
                className="transition-colors hover:text-[var(--brand-ink)]"
              >
                orders@filament.cleverdeals.net
              </a>
            </li>
          </ul>
        </section>

        <section aria-labelledby="footer-about" className="md:col-span-2">
          <h2
            id="footer-about"
            className="mb-4 text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]"
          >
            About
          </h2>
          <p className="max-w-md leading-relaxed">{ABOUT_BLURB}</p>
        </section>
      </div>

      <div className="mx-auto mt-10 flex max-w-6xl flex-col gap-3 border-t border-[var(--brand-border)] px-6 pt-6 text-xs md:flex-row md:items-center md:justify-between">
        <p>
          © {year} {STORE_NAME}
        </p>
        <p>
          Powered by{' '}
          <a
            href="https://cleverdeals.net/"
            className="font-semibold text-[var(--brand-ink)] transition-colors hover:text-[var(--brand-accent)]"
            rel="noopener"
          >
            CleverDeals
          </a>
        </p>
      </div>
    </footer>
  );
}
