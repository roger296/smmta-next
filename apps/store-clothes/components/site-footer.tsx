/**
 * Site footer — internal links to every top-level category plus the static
 * help pages. Surfacing the categories here gives every page in the
 * storefront a crawlable route into the whole catalogue, and the category
 * pages link on to each range.
 *
 * Categories rather than ranges: the drop-ship catalogues run to thousands of
 * ranges, so a link per range would make an enormous footer and a full
 * catalogue read on every page render.
 *
 * Server component; reads `listCategories` directly (cached for five
 * minutes). Failures fall back to a footer with no category links so the
 * page still renders.
 *
 * The "Powered by CleverDeals" link in the bottom strip acknowledges
 * the parent retailer relationship without requiring the storefront's
 * visual identity to inherit CleverDeals' yellow-on-black palette.
 */
import Link from 'next/link';
import { listCategories } from '@/lib/smmta';

const STORE_NAME = 'Clothes Shop';
const CONTACT_EMAIL = 'sales@cleverdeals.net';
const ABOUT_BLURB =
  'Friendly, simple clothing for everyday wear. Real sizes, honest pricing, fast UK delivery from our supplier partners. Pick your colour, pick your size, and we ship the next working day.';

export async function SiteFooter() {
  let categories: Awaited<ReturnType<typeof listCategories>> = [];
  try {
    categories = await listCategories();
  } catch {
    categories = [];
  }

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
                All categories
              </Link>
            </li>
            {categories
              .filter((c) => Boolean(c.slug))
              .map((c) => (
                <li key={c.slug}>
                  <Link
                    href={`/shop/c/${c.slug}`}
                    className="transition-colors hover:text-[var(--brand-ink)]"
                  >
                    {c.name}
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
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="transition-colors hover:text-[var(--brand-ink)]"
              >
                {CONTACT_EMAIL}
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
