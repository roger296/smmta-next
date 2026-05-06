import type { Metadata, Viewport } from 'next';
import './globals.css';
import { fontClassName } from '@/lib/fonts';
import { getEnv } from '@/lib/env';
import { QueryProvider } from '@/components/query-provider';
import { CartHeaderLink } from '@/components/cart-header-link';
import { SiteFooter } from '@/components/site-footer';

const STORE_NAME = 'Filament Store';
const STORE_TAGLINE =
  'Premium 3D printer filament — PLA, PETG, ABS, ASA, TPU. Tight tolerances, fast UK delivery.';

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

function Header() {
  return (
    <header className="border-b border-[var(--brand-border)] bg-[var(--brand-paper)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-5">
        <a
          href="/"
          className="text-lg font-bold tracking-tight transition-colors hover:text-[var(--brand-accent)]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {STORE_NAME}
        </a>
        <nav aria-label="Primary">
          <ul className="flex items-center gap-7 text-sm font-medium">
            <li>
              <a
                href="/shop"
                className="transition-colors hover:text-[var(--brand-accent)]"
              >
                Shop
              </a>
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
    </header>
  );
}
