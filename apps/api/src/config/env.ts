import { z } from 'zod';

/**
 * Env → boolean. `z.coerce.boolean()` is unusable here because it does
 * `Boolean(value)`, so the string "false" coerces to `true`. We treat
 * only "true"/"1" (case-insensitive) as on; anything else — including
 * unset — is off.
 */
const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v?.toLowerCase() === 'true' || v === '1');

const envSchema = z.object({
  // Server
  // Default API port. The storefront (Prompt 7) takes :3000, so the API
  // moves to :8080. Override via PORT env if you're running outside the
  // monorepo conventions.
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().default('postgresql://smmta:smmta@localhost:5432/smmta_next'),

  // Auth
  JWT_SECRET: z.string().default('dev-secret-change-in-production'),

  // Singleton tenant id. smmta-next is single-tenant per deployment;
  // every row's `company_id` is set to this value. Defaults to the
  // Filament Store production UUID so existing deployments keep working
  // without any env change.
  COMPANY_ID: z.string().default('11111111-1111-4111-8111-111111111111'),

  // Luca GL API
  LUCA_API_BASE_URL: z.string().default('http://localhost:4000'),
  LUCA_API_TIMEOUT_MS: z.coerce.number().default(10000),

  // Redis (for BullMQ)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Storefront — used when the API needs to call the storefront's
  // internal email-rendering route (e.g. back-in-stock notifications
  // triggered by a GRN). Empty string disables the call (the queue
  // stays pending and a subsequent trigger retries when the env is set).
  STORE_BASE_URL: z.string().default(''),
  STORE_INTERNAL_API_KEY: z.string().default(''),

  // ── Feature flags (Auto-Stock / Big Bakes fork) ────────────────────
  // Subsystems inherited from the smmta-next fork that are NOT part of
  // the Big Bakes stock-control remit (spec §A2) are kept in the tree
  // but dormant, gated here. All default OFF; set the env var to "true"
  // in a deployment that genuinely wants them back.
  //
  //   FEATURE_MARKETPLACE           — POST /import/marketplace + the
  //                                   Amazon/eBay/Etsy/Shopify connectors.
  //   FEATURE_CONVERSATIONAL_SEARCH — the Claude-Haiku natural-language
  //                                   storefront search. Off ⇒ /storefront/
  //                                   search still works but falls back to
  //                                   plain keyword matching (no LLM call).
  FEATURE_MARKETPLACE: boolFromEnv,
  FEATURE_CONVERSATIONAL_SEARCH: boolFromEnv,
});

export type Env = z.infer<typeof envSchema>;

export interface Features {
  marketplace: boolean;
  conversationalSearch: boolean;
}

/** Resolved feature flags. See the FEATURE_* fields above (all default off). */
export function getFeatures(): Features {
  const env = getEnv();
  return {
    marketplace: env.FEATURE_MARKETPLACE,
    conversationalSearch: env.FEATURE_CONVERSATIONAL_SEARCH,
  };
}

let _env: Env | undefined;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
