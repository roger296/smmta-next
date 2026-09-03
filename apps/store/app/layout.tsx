import type { Metadata, Viewport } from 'next';
import Image from 'next/image';
import './globals.css';
import { fontClassName } from '@/lib/fonts';
import { getEnv } from '@/lib/env';
import { QueryProvider } from '@/components/query-provider';
import { CartHeaderLink } from '@/components/cart-header-link';
import { SiteFooter } from '@/components/site-footer';
import { ChatPanel } from '@/components/chat-panel';
import { getComingSoon } from '@/lib/smmta';
import { LEGAL } from '@/lib/legal';

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

/**
 * Organization schema.
 *
 * Previously name + url + description only, while the footer already
 * printed the registered address, company number, VAT number and a
 * contact address. Everything below was sitting in `lib/legal.ts` and
 * simply wasn't being declared — free structured data for a brand with
 * no other authority signals yet.
 */
const organizationLd = {
  '@context': 'https://schema.org',
  '@type': 'OnlineStore',
  name: STORE_NAME,
  url: baseUrl.toString(),
  description: STORE_TAGLINE,
  logo: new URL('/cleverdeals-logo.png', baseUrl).toString(),
  parentOrganization: { '@type': 'Organization', name: LEGAL.parentName, url: LEGAL.parentUrl },
  legalName: LEGAL.legalEntity,
  vatID: LEGAL.vatNumber ?? undefined,
  identifier: {
    '@type': 'PropertyValue',
    name: 'Companies House registration',
    value: LEGAL.companyNumber,
  },
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'Suite 48, Beechfield House, Winterton Way',
    addressLocality: 'Macclesfield',
    postalCode: 'SK11 0LP',
    addressCountry: 'GB',
  },
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    email: LEGAL.contactEmail,
    areaServed: 'GB',
    availableLanguage: 'English',
  },
  currenciesAccepted: 'GBP',
  areaServed: 'GB',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={fontClassName}>
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
          <ChatPanel />
        </QueryProvider>
      </body>
    </html>
  );
}

async function Header() {
  // Bug 10: "Coming soon" sat in the nav on every page pointing at an
  // empty list. A nav item that leads nowhere costs a click and a bit
  // of trust, and the page itself was index,follow — a thin page
  // competing for crawl budget. Hidden here, noindexed there, both
  // driven by the same emptiness check.
  //
  // Failure is treated as empty: if the API is unreachable we'd rather
  // drop a secondary nav item than render a link into an error page.
  const comingSoon = await getComingSoon().catch(() => []);
  const hasComingSoon = comingSoon.length > 0;

  return (
    <header className="border-b border-[var(--brand-border)] bg-[var(--brand-paper)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-5">
        {/*
          CleverDeals parent-brand logo. The storefront (filament.cleverdeals.net)
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
              <a
                href="/shop"
                className="transition-colors hover:text-[var(--brand-accent)]"
              >
                Shop
              </a>
            </li>
            {hasComingSoon && (
              <li>
                <a
                  href="/shop/coming-soon"
                  className="transition-colors hover:text-[var(--brand-accent)]"
                >
                  Coming soon
                </a>
              </li>
            )}
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
