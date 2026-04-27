import type { Metadata, Viewport } from 'next';
import './globals.css';
import { fontVariables } from '@/lib/fonts';
import { getEnv } from '@/lib/env';

const STORE_NAME = 'Filament Store';
const STORE_TAGLINE = 'Hand-finished LED filament lighting.';

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
  icons: {
    // No real icon yet — placeholder so browsers don't 404 noisily.
    icon: '/favicon.ico',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf7' },
    { media: '(prefers-color-scheme: dark)', color: '#18181b' },
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
    <html lang="en" style={fontVariables}>
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
        <Header />
        <main id="main" className="mx-auto max-w-6xl px-6 py-10">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}

function Header() {
  return (
    <header className="border-b border-[var(--brand-border)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href="/" className="text-xl font-medium" style={{ fontFamily: 'var(--font-display)' }}>
          {STORE_NAME}
        </a>
        <nav aria-label="Primary">
          <ul className="flex gap-6 text-sm">
            <li>
              <a href="/shop" className="hover:underline">
                Shop
              </a>
            </li>
            <li>
              <a href="/cart" className="hover:underline">
                Cart
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[var(--brand-border)] py-8 text-sm text-[var(--brand-muted)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 md:flex-row md:items-center md:justify-between">
        <p>
          © {new Date().getFullYear()} {STORE_NAME}
        </p>
        <p>{STORE_TAGLINE}</p>
      </div>
    </footer>
  );
}
