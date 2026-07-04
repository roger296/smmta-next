import { z } from 'zod';

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

  // Worker / pg-boss. The queue lives in the same Postgres as everything
  // else (SPEC §4.2) in its own schema, so a single pg_dump captures orders,
  // stock, AND pending jobs.
  PGBOSS_SCHEMA: z.string().default('pgboss'),

  // Payments (Mollie, §16). TEST key only during the build. Empty → the
  // in-memory fake is used (dev/test), so the app boots without a key.
  MOLLIE_API_KEY: z.string().default(''),
  APP_BASE_URL: z.string().default('http://localhost:3000'),

  // LLM (OpenRouter, §4.5). Empty key → the scripted fake is used (dev/test).
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3.5-haiku'),
  OPENROUTER_FALLBACK_MODELS: z.string().default('google/gemini-flash-1.5'),
  /** Per-day spend ceiling in integer micro-USD (1_000_000 = $1.00). */
  OPENROUTER_DAILY_CAP_MICROUSD: z.coerce.number().int().default(2_000_000),

  // Email (SendGrid, §4.6). Empty key or SENDGRID_SANDBOX → the fake is used.
  SENDGRID_API_KEY: z.string().default(''),
  SENDGRID_WEBHOOK_KEY: z.string().default('dev-webhook-key'),
  SENDGRID_FROM_TRANSACTIONAL: z.string().default('orders@filament.shop.cleverdeals.net'),
  SENDGRID_FROM_MARKETING: z.string().default('hello@filament.shop.cleverdeals.net'),
  SENDGRID_SANDBOX: z.coerce.boolean().default(true),
  /** Signs one-click unsubscribe URLs. */
  UNSUBSCRIBE_SECRET: z.string().default('dev-unsubscribe-secret'),
  /** Marketing frequency cap: max N messages per user per rolling M days. */
  MARKETING_FREQ_CAP_COUNT: z.coerce.number().int().default(3),
  MARKETING_FREQ_CAP_DAYS: z.coerce.number().int().default(7),
  /** Marketing agent: max drafts composed per nightly run. */
  MARKETING_MAX_SENDS_PER_NIGHT: z.coerce.number().int().default(200),

  // Observability (Sentry, §6). Off unless a DSN + flag are set.
  SENTRY_DSN: z.string().default(''),
  SENTRY_ENABLED: z.coerce.boolean().default(false),
  /** Worker health-check HTTP port (0 disables the server). */
  WORKER_HEALTH_PORT: z.coerce.number().int().default(0),

  // Storefront — used when the API needs to call the storefront's
  // internal email-rendering route (e.g. back-in-stock notifications
  // triggered by a GRN). Empty string disables the call (the queue
  // stays pending and a subsequent trigger retries when the env is set).
  STORE_BASE_URL: z.string().default(''),
  STORE_INTERNAL_API_KEY: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

/** Every environment key the app reads. Used by the config-coverage test to
 *  prove `.env.example` documents every variable. */
export const ENV_KEYS: readonly string[] = Object.keys(envSchema.shape);

let _env: Env | undefined;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
