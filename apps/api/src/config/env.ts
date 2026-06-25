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

/** Like boolFromEnv but defaults to ON; only an explicit "false"/"0" turns it off. */
const boolFromEnvDefaultTrue = z
  .string()
  .optional()
  .transform((v) => !(v?.toLowerCase() === 'false' || v === '0'));

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

  // Stock-take-lite (P26): shared access code for the standalone iPad demo.
  // The demo is NOT JWT-gated; every /stocktake-lite route checks this code in
  // the x-stocktake-code header. Empty ⇒ gate open (dev only) — a deployment
  // MUST set this.
  STOCKTAKE_ACCESS_CODE: z.string().default(''),

  // Singleton tenant id. smmta-next is single-tenant per deployment;
  // every row's `company_id` is set to this value. Defaults to the
  // Filament Store production UUID so existing deployments keep working
  // without any env change.
  COMPANY_ID: z.string().default('11111111-1111-4111-8111-111111111111'),

  // Luca GL API
  LUCA_API_BASE_URL: z.string().default('http://localhost:4000'),
  LUCA_API_TIMEOUT_MS: z.coerce.number().default(10000),

  // ── GL provider (spec §A2/§A8) ─────────────────────────────────────
  // Big Bakes posts to Xero; the Luca path stays intact + selectable.
  GL_PROVIDER: z.enum(['luca', 'xero']).default('xero'),
  // Xero app credentials (app-level; per-org token state lives in the DB,
  // AES-encrypted). Empty ⇒ unconfigured ⇒ the GL service stays in dry-run.
  XERO_CLIENT_ID: z.string().default(''),
  XERO_CLIENT_SECRET: z.string().default(''),
  XERO_TENANT_ID: z.string().default(''),
  XERO_API_BASE_URL: z.string().default('https://api.xero.com/api.xro/2.0'),
  // Global dry-run guard — DEFAULT TRUE. In dry-run the GL service records the
  // intended journal in gl_posting_log.request_payload and sends nothing.
  // Only ever disabled against a Xero Demo Company during the build.
  XERO_DRY_RUN: boolFromEnvDefaultTrue,

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

  // ── BumbleBee shared catalogue (spec §A4) ──────────────────────────
  // Auto-Stock is system-of-record; BumbleBee consumes a slim subset. The
  // outbound push is OFF by default — the BumbleBee write endpoint is a
  // documented follow-up; until then a sync logs the intended payload only.
  CATALOGUE_SYNC: boolFromEnv,
  BUMBLEBEE_API_BASE_URL: z.string().default(''),
  BUMBLEBEE_API_KEY: z.string().default(''),
  // Outbound per-session materials-cost push to BumbleBee (spec §A8, P17). OFF
  // by default — the BumbleBee write endpoint is a follow-up; until then a sync
  // logs the intended payload (dry-run) and sends nothing.
  MATERIALS_COST_SYNC: boolFromEnv,
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

/** Test-only: clear the memoised env so the next getEnv() re-reads process.env. */
export function resetEnvForTests(): void {
  _env = undefined;
}
