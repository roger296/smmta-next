/**
 * Typed env access for the storefront. Imports are server-only — the
 * `import 'server-only'` guard prevents this module from being bundled into
 * any client component by accident, which would leak SMMTA / Mollie /
 * SendGrid keys into the browser.
 */
import 'server-only';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Storefront DB (separate database, same Postgres instance as SMMTA-NEXT).
  DATABASE_URL: z
    .string()
    .default('postgresql://smmta:smmta@localhost:5432/smmta_store'),

  // SMMTA-NEXT API surface.
  SMMTA_API_BASE_URL: z.string().default('http://localhost:8080/api/v1'),
  SMMTA_API_KEY: z.string().default(''),

  // Mollie (wired in Prompt 10).
  MOLLIE_API_KEY: z.string().default(''),
  MOLLIE_WEBHOOK_URL_BASE: z.string().default('http://localhost:3000'),

  // SendGrid (wired in Prompt 11).
  SENDGRID_API_KEY: z.string().default(''),
  SENDGRID_FROM: z.string().default('orders@example.invalid'),

  // Operator-only admin surface (Prompt 12).
  ADMIN_API_KEY: z.string().default(''),

  // Observability (Prompt 14). Both are optional — empty values disable
  // the Sentry SDK at boot so dev / test runs never emit events.
  SENTRY_DSN: z.string().default(''),
  /** Sample rate for performance traces (0..1). 0 disables tracing. */
  SENTRY_TRACES_SAMPLE_RATE: z
    .string()
    .regex(/^(0(\.\d+)?|1(\.0+)?)$/)
    .default('0'),

  // Public storefront origin — used for canonical URLs / OG images.
  STORE_BASE_URL: z.string().default('http://localhost:3000'),

  // HMAC secret used to sign the cart_id cookie (Prompt 9). The default
  // here is unsafe in production but fine for tests; the deploy in
  // Prompt 14 sets a 64-byte random secret in /etc/smmta/store.env.
  STORE_COOKIE_SECRET: z
    .string()
    .min(16)
    .default('dev-cookie-secret-change-in-production-please'),

  // Fixed shipping rate for v1 (Prompt 10). Real shipping rules / zones
  // arrive in a later phase per the architecture doc's "stop and ask"
  // list. Major-unit decimal string, e.g. "4.95".
  STORE_DEFAULT_SHIPPING_GBP: z
    .string()
    .regex(/^\d+(\.\d{2})?$/, 'STORE_DEFAULT_SHIPPING_GBP must be a major-unit string')
    .default('4.95'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;
export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
