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

  // Public storefront origin — used for canonical URLs / OG images.
  STORE_BASE_URL: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;
export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
