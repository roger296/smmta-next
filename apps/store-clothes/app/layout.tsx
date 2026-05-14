import type { Metadata, Viewport } from 'next';
import Image from 'next/image';
import './globals.css';
import { fontClassName } from '@/lib/fonts';
import { getEnv } from '@/lib/env';
import { QueryProvider } from '@/components/query-provider';
import { CartHeaderLink } from '@/components/cart-header-link';
import { Suspense } from 'react';
import { SearchBar } from '@/components/search-bar';
import { ShopMegamenu, type NavCategoryTop } from '@/components/shop-megamenu';
import { listCategories } from '@/lib/smmta';
import { SiteFooter } from '@/components/site-footer';

const STORE_NAME = 'Clothes Shop';
const STORE_TAGLINE =
  'Friendly clothes in real sizes — fast UK delivery, easy returns. Pick your colour, pick your size.';

// `metadataBase` so OG / canonical / sitemap URLs resolve to absolute paths.
const env = getEnv();
const baseUrl = (() => {
  try {
    return new URL(env.STORE_BASE_URL);
  } catch {
    return new URL('http://localhost:3000');
  }
})();

export const metadata: Metadata = {
  metadataBase: baseUrl,
  title: {
    default: STORE_NAME,
    template: `%s | ${STORE_NAME}`,
  },
  description: STORE_TAGLINE,
  applicationName: STORE_NAME,
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: STORE_NAME,
    title: STORE_NAME,
    description: STORE_TAGLINE,
  },
  twitter: {
    card: 'summary_large_image',
    title: STORE_NAME,
    description: STORE_TAGLINE,
  },
  // The icon set is provided by `app/icon.tsx` and `app/apple-icon.tsx`
  // (dynamic ImageResponse routes). Next picks them up automatically.
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ECECE8' },
    { media: '(prefers-color-scheme: dark)', color: '#15161A' },
  ],
};

const organizationLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: STORE_NAME,
  url: baseUrl.toString(),
  description: STORE_TAGLINE,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontClassName}>
      <head>
        {/* Organization JSON-LD lives at the layout level so every page emits it. */}
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationLd) }}
        />
      </head>
      <body className="min-h-screen bg-[var(--brand-paper)] text-[var(--brand-ink)]">
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        <QueryProvider>
          <Header />
          <main id="main" className="mx-auto max-w-6xl px-6 py-12 md:py-16">
            {children}
          </main>
          <SiteFooter />
        </QueryProvider>
      </body>
    </html>
  );
}

/** Skeleton shown by <Suspense> while SearchBar hydrates — static-safe
 *  so the layout can pre-render without bailing out on `useSearchParams`. */
function SearchBarFallback() {
  return (
    <div
      role="search"
      className="flex w-full max-w-xl items-center border border-[var(--brand-border)] bg-[var(--brand-paper)]"
    >
      <input
        type="search"
        placeholder="What are you shopping for today?"
        disabled
        className="flex-1 bg-transparent px-4 py-2 text-sm outline-none placeholder:text-[var(--brand-muted)]"
        aria-hidden="true"
      />
      <span className="border-l border-[var(--brand-border)] bg-[var(--brand-ink)] px-4 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--brand-paper)]">
        Search
      </span>
    </div>
  );
}

async function Header() {
  // Fetch nav categories server-side. Cached aggressively (5 min)
  // via `listCategories` so this round-trip doesn't cost on every
  // page render — the storefront is largely cache-friendly.
  let categories: NavCategoryTop[] = [];
  try {
    categories = await listCategories();
  } catch {
    categories = [];
  }
  return (
    <header className="border-b border-[var(--brand-border)] bg-[var(--brand-paper)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-5">
        {/*
          CleverDeals parent-brand logo. The storefront (filament.shop.cleverdeals.net)
          presents as a CleverDeals property — the Filament Store identity now lives in
          the page copy, hero, and footer rather than in a top-left wordmark.
          Source asset: 1500×245 PNG (transparent), rendered at 196×32 on screen so
          retina screens still get a sharp resample. `priority` because it's above the
          fold; without it Next defers the load and the header shows blank for ~150ms.
        */}
        <a
          href="/"
          aria-label={`${STORE_NAME} — home`}
          className="inline-flex items-center transition-opacity hover:opacity-80"
        >
          <Image
            src="/cleverdeals-logo.png"
            alt="CleverDeals"
            width={196}
            height={32}
            priority
            className="h-8 w-auto"
          />
        </a>
        <nav aria-label="Primary">
          <ul className="flex items-center gap-7 text-sm font-medium">
            <li>
              <ShopMegamenu categories={categories} />
            </li>
            <li>
              <a
                href="/faq"
                className="transition-colors hover:text-[var(--brand-accent)]"
              >
                FAQ
              </a>
            </li>
            <li>
              <CartHeaderLink />
            </li>
          </ul>
        </nav>
      </div>
      {/* Secondary row: the conversational search bar. Full-width on
          mobile, centred + capped on desktop. Wrapped in a Suspense
          boundary because <SearchBar /> reads `useSearchParams`, which
          Next.js requires inside a Suspense to avoid breaking the
          static prerender of pages like /404 that include the layout. */}
      <div className="border-t border-[var(--brand-border)] bg-[var(--brand-bone)]">
        <div className="mx-auto flex max-w-6xl justify-center px-6 py-3">
          <Suspense fallback={<SearchBarFallback />}>
            <SearchBar />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
