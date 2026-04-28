/**
 * Site footer — emits internal links to every published group plus the
 * static legal / FAQ pages. Surfacing the group list here gives every
 * page in the storefront a crawlable link to every category, which
 * helps with internal-link equity and is one of the cheapest SEO
 * wins available.
 *
 * Server component; reads `listGroups` directly. Failures fall back to
 * a footer with no category links so the page still renders.
 */
import Link from 'next/link';
import { listGroups } from '@/lib/smmta';

const STORE_NAME = 'Filament Store';
const STORE_TAGLINE = 'Hand-finished LED filament lighting.';

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

  return (
    <footer className="mt-16 border-t border-[var(--brand-border)] py-10 text-sm text-[var(--brand-muted)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 md:grid-cols-4">
        <section aria-labelledby="footer-shop">
          <h2 id="footer-shop" className="mb-3 font-medium text-[var(--brand-ink)]">
            Shop
          </h2>
          <ul className="space-y-1.5">
            <li>
              <Link href="/shop" className="hover:underline">
                All ranges
              </Link>
            </li>
            {sorted
              .filter((g): g is typeof g & { slug: string } => Boolean(g.slug))
              .map((g) => (
                <li key={g.id}>
                  <Link href={`/shop/${g.slug}`} className="hover:underline">
                    {g.name}
                  </Link>
                </li>
              ))}
          </ul>
        </section>

        <section aria-labelledby="footer-help">
          <h2 id="footer-help" className="mb-3 font-medium text-[var(--brand-ink)]">
            Help
          </h2>
          <ul className="space-y-1.5">
            <li>
              <Link href="/faq" className="hover:underline">
                Shipping &amp; FAQ
              </Link>
            </li>
            <li>
              <a href="mailto:orders@filament.shop" className="hover:underline">
                orders@filament.shop
              </a>
            </li>
          </ul>
        </section>

        <section aria-labelledby="footer-about" className="md:col-span-2">
          <h2 id="footer-about" className="mb-3 font-medium text-[var(--brand-ink)]">
            About
          </h2>
          <p className="max-w-md leading-relaxed">
            {STORE_TAGLINE} Designed and finished in a small UK workshop. Every
            lamp is dimmable on any standard trailing-edge dimmer and rated for
            25,000 hours.
          </p>
        </section>
      </div>
      <div className="mx-auto mt-8 flex max-w-6xl flex-col gap-2 border-t border-[var(--brand-border)] px-6 pt-6 md:flex-row md:items-center md:justify-between">
        <p>
          © {new Date().getFullYear()} {STORE_NAME}
        </p>
        <p>{STORE_TAGLINE}</p>
      </div>
    </footer>
  );
}
