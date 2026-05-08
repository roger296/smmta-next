/**
 * Vitest setup for @smmta/store.
 *
 * Sets a default DATABASE_URL pointing at the docker-compose Postgres so
 * `npm test` works without an env file, and stubs `server-only` so modules
 * guarded by it can still be imported from a vitest worker (they aren't
 * actually rendered in a Next request, so the guard is harmless here).
 */
import { vi } from 'vitest';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://smmta:smmta@localhost:5432/smmta_store';
}
// `process.env.NODE_ENV` is typed readonly under modern `@types/node` when
// strict mode is on. Object.assign side-steps the static check while still
// performing the same runtime mutation.
if (!process.env.NODE_ENV) {
  Object.assign(process.env, { NODE_ENV: 'test' });
}

vi.mock('server-only', () => ({}));
