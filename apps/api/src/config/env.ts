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

  // Luca GL API
  LUCA_API_BASE_URL: z.string().default('http://localhost:4000'),
  LUCA_API_TIMEOUT_MS: z.coerce.number().default(10000),

  // Redis (for BullMQ)
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
