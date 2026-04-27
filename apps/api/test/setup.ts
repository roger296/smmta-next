/**
 * Vitest global setup — applies before every test file in @smmta/api.
 *
 * - Loads `.env` if present (the repo doesn't ship one; tests work without).
 * - Applies a default DATABASE_URL pointing at the docker-compose Postgres
 *   so a fresh checkout `npm test` works as long as `docker compose up -d`
 *   has been run.
 * - Forces NODE_ENV=test so any code that branches on it behaves predictably.
 */
import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://smmta:smmta@localhost:5432/smmta_next';
}

process.env.NODE_ENV = 'test';
