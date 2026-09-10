/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === 'production';

// Build a CSP from a deny-by-default base. Tightened in prod to forbid inline
// eval/script-src; permissive in dev so Next's HMR + React DevTools work.
//
// Mollie's hosted checkout lives on https://www.mollie.com — we don't embed
// it (the customer is redirected away), so frame-src is restrictive.
//
// Two development artefacts were removed from the production policy after a
// security review flagged them: picsum.photos (a placeholder image service,
// now dev-only) and the API origin, which in the Docker deploy resolves to
// the internal service name `http://api:3000`. The browser never calls the
// API directly — every call goes through this app's own /api/* proxy routes
// on the same origin — so publishing an internal hostname over plain HTTP
// widened the policy while granting nothing.

/** Only a public https origin belongs in a browser-facing CSP. An internal
 *  Docker service name is unreachable from a browser and just leaks topology. */
function publicApiOrigin() {
  if (!process.env.SMMTA_API_BASE_URL) return '';
  try {
    const { origin, protocol } = new URL(process.env.SMMTA_API_BASE_URL);
    return protocol === 'https:' ? origin : '';
  } catch {
    return '';
  }
}
const csp = [
  `default-src 'self'`,
  `base-uri 'self'`,
  `frame-ancestors 'none'`,
  `form-action 'self' https://www.mollie.com https://*.mollie.com`,
  isProd
    ? `img-src 'self' data: blob: https:`
    : `img-src 'self' data: blob: https://picsum.photos https://fastly.picsum.photos https:`,
  `font-src 'self' data:`,
  `style-src 'self' 'unsafe-inline'`,
  // Next 15 with React Server Components emits inline `<script>` tags into
  // every HTML response to ship the RSC payload to the browser. Without
  // 'unsafe-inline' those scripts are CSP-blocked, hydration fails, and the
  // page goes blank ~100ms after the server-rendered HTML arrives. The
  // long-term fix is nonce-based CSP via middleware (issue #TBD); for now
  // 'unsafe-inline' matches dev mode and is the same fix used by most Next 15
  // RSC production deployments.
  //
  // Google Analytics (components/analytics-consent.tsx) loads gtag.js from
  // googletagmanager.com — only after the visitor accepts cookies — and sends
  // hits to the google-analytics.com / analytics.google.com collection hosts,
  // which vary by region, hence the wildcards. img-src already allows https:.
  isProd
    ? `script-src 'self' 'unsafe-inline' https://www.googletagmanager.com`
    : `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com`,
  `connect-src 'self' https://api.mollie.com https://*.sentry.io https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com ${publicApiOrigin()}`.trim(),
  `object-src 'none'`,
  `worker-src 'self' blob:`,
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=()',
  },
  ...(isProd
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains; preload',
        },
      ]
    : []),
];

/**
 * One next/image remotePatterns entry for an origin, or none if the value is
 * absent or unparseable. A bad value used to throw from inside the config and
 * fail the build without indicating which variable was at fault.
 *
 * NB remotePatterns are evaluated by `next build` and baked into the standalone
 * output, so the origin must arrive as a BUILD ARG. A runtime environment
 * variable of the same name has no effect on the allow-list.
 */
function remotePatternFor(origin) {
  if (!origin) return [];
  try {
    const u = new URL(origin);
    return [{ protocol: u.protocol.replace(':', ''), hostname: u.hostname }];
  } catch {
    console.warn(`[next.config] Ignoring unparseable image origin: ${origin}`);
    return [];
  }
}

const nextConfig = {
  // Don't advertise the framework. Free information for anyone
  // fingerprinting the stack for known-version exploits.
  poweredByHeader: false,
  // Standalone output bakes the runtime into .next/standalone for the
  // systemd unit in Prompt 14 — `node .next/standalone/server.js`.
  output: 'standalone',

  // Native modules and SDKs that must run in Node, not the Edge bundle.
  // Listing them here keeps Next from trying to bundle them for browsers.
  // (Argon2 / Mollie / SendGrid are loaded later prompts; declared now so
  // the next.config doesn't churn on every prompt.)
  serverExternalPackages: ['@mollie/api-client', '@sendgrid/mail', 'argon2'],

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      // Public API origin. Uploaded product images are served from
      // <APP_BASE_URL>/uploads/..., which is the API's PUBLIC host — whereas
      // SMMTA_API_BASE_URL below is the internal Docker address in production
      // (http://api:3000). Without this, every uploaded image 400s through
      // next/image while pasted external URLs keep working, which reads as
      // "uploads are broken" rather than as a missing allow-list entry.
      //
      // APP_BASE_URL is the fallback because this is read at BUILD time, and a
      // value that exists only in the compose `environment:` block does not
      // exist then — that is precisely how the first attempt at this failed.
      // APP_BASE_URL is a deploy-platform variable in its own right (the API
      // builds the upload URLs from it), so it is present wherever the build
      // runs. The two are the same origin by definition.
      ...remotePatternFor(process.env.SMMTA_API_PUBLIC_URL || process.env.APP_BASE_URL),
      // SMMTA-NEXT API host (hero / gallery URLs flow through it).
      ...(process.env.SMMTA_API_BASE_URL
        ? remotePatternFor(process.env.SMMTA_API_BASE_URL)
        : [
            { protocol: 'http', hostname: 'localhost' },
            { protocol: 'http', hostname: '127.0.0.1' },
          ]),
      // picsum.photos for legacy placeholder images (kept for tests).
      { protocol: 'https', hostname: 'picsum.photos' },
      { protocol: 'https', hostname: 'fastly.picsum.photos' },
      // Real catalogue product images: Roger's existing inventory
      // image host plus eBay's image CDN (some product photos still
      // live there pending re-hosting).
      { protocol: 'https', hostname: 'app.etailsupport.com' },
      { protocol: 'https', hostname: 'i.ebayimg.com' },
    ],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      // Edge-cacheable public pages.
      //
      // Every HTML response carried `private, no-cache, no-store` — Next's
      // default for force-dynamic routes — so every visitor and every
      // crawler request went to origin. TTFB is already good, so this is
      // a ceiling-raiser rather than a fix, and it caps crawl efficiency
      // as the catalogue grows.
      //
      // Listed route by route ON PURPOSE rather than as a blanket rule
      // with exceptions. A shared cache serving one visitor's page to
      // another is a data leak, so the safe default has to be no-store
      // and each cacheable path has to be argued for individually. Every
      // path below renders identically for all visitors: the cart badge
      // is a client-side fetch, so no cart state reaches the HTML.
      //
      // `max-age=0` keeps browsers revalidating (a customer should see a
      // price change immediately); `s-maxage` applies only to shared
      // caches; `stale-while-revalidate` lets a CDN serve the old copy
      // while it refreshes. /cart, /checkout, /track and /api keep
      // Next's no-store and are deliberately absent.
      ...[
        '/',
        '/shop',
        '/shop/:slug',
        '/shop/p/:slug',
        '/pla',
        '/petg',
        '/abs',
        '/asa',
        '/tpu',
        '/faq',
        '/about',
        '/legal/:path*',
      ].map((source) => ({
        source,
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
          },
        ],
      })),
    ];
  },
};

export default nextConfig;
