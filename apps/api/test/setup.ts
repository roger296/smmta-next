/**
 * Vitest global setup — applies before every test file in @smmta/api.
 *
 * - Loads `.env` if present (the repo doesn't ship one; tests work without).
 * - Integration tests run against a DEDICATED test database so they never
 *   touch dev data. Resolution order:
 *     1. TEST_DATABASE_URL (preferred — a throwaway DB migrated to head)
 *     2. DATABASE_URL (back-compat for callers that set it directly)
 *     3. the docker-compose `filament_test` default
 *   Whatever is chosen is copied into DATABASE_URL, which every app module
 *   reads via config/env.ts.
 * - Forces NODE_ENV=test so any code that branches on it behaves predictably.
 *
 * Note (Prompt 0): the test DB must be migrated first —
 *   `TEST_DATABASE_URL=... npm run db:migrate -w @smmta/api`
 * or, for the default, create + migrate `filament_test`. See BUILD_LOG entry 0.
 */
import 'dotenv/config';

const testDbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://smmta:smmta@localhost:5432/filament_test';

process.env.DATABASE_URL = testDbUrl;
process.env.NODE_ENV = 'test';

// The OpenRouter daily spend cap sums llm_log across the whole database for
// today, so every scripted FakeLlm call from every earlier suite (and every
// earlier run that day) counts towards it. At the production default of
// 2,000,000 micro-USD a busy day of test runs, or one suite that died before
// its cleanup, would trip the cap for every later suite until UTC midnight.
// Tests run with a cap no realistic run can reach; the spend-cap test seeds
// spend relative to whatever cap is configured. Kept within Postgres
// `integer` range because llm_log.cost_micro_usd is an int4 column.
process.env.OPENROUTER_DAILY_CAP_MICROUSD ??= '1000000000';
