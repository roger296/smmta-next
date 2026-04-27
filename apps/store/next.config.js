/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === 'production';

// Build a CSP from a deny-by-default base. Tightened in prod to forbid inline
// eval/script-src; permissive in dev so Next's HMR + React DevTools work.
//
// Mollie's hosted checkout lives on https://www.mollie.com — we don't embed
// it (the customer is redirected away), so frame-src is restrictive. The
// img-src / connect-src lists cover the API host, picsum.photos for seed
// images, and Sentry / GA4 endpoints when those are wired in later phases.
const csp = [
  `default-src 'self'`,
  `base-uri 'self'`,
  `frame-ancestors 'none'`,
  `form-action 'self' https://www.mollie.com https://*.mollie.com`,
  `img-src 'self' data: blob: https://picsum.photos https://fastly.picsum.photos https:`,
  `font-src 'self' data:`,
  `style-src 'self' 'unsafe-inline'`,
  isProd
    ? `script-src 'self'`
    : `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
  `connect-src 'self' https://api.mollie.com https://*.sentry.io ${
    process.env.SMMTA_API_BASE_URL ? new URL(process.env.SMMTA_API_BASE_URL).origin : ''
  }`.trim(),
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

const nextConfig = {
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
      // SMMTA-NEXT API host (hero / gallery URLs flow through it).
      ...(process.env.SMMTA_API_BASE_URL
        ? [
            (() => {
              const u = new URL(process.env.SMMTA_API_BASE_URL);
              return { protocol: u.protocol.replace(':', ''), hostname: u.hostname };
            })(),
          ]
        : [
            { protocol: 'http', hostname: 'localhost' },
            { protocol: 'http', hostname: '127.0.0.1' },
          ]),
      // picsum.photos for seeded placeholder images (Prompt 1 seed).
      { protocol: 'https', hostname: 'picsum.photos' },
      { protocol: 'https', hostname: 'fastly.picsum.photos' },
    ],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
