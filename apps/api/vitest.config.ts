import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for @smmta/api.
 *
 * - Unit tests: co-located `*.test.ts` next to source files.
 * - Integration tests: also `*.test.ts`, but they require a running Postgres
 *   instance reachable at `DATABASE_URL` (default points at the
 *   docker-compose Postgres at `postgresql://smmta:smmta@localhost:5432/smmta_next`).
 * - `setupFiles` loads `.env` (if present) and applies a sane default for
 *   `DATABASE_URL` so local runs don't need any env file.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // DB-touching integration tests share the same Postgres instance; running
    // them in parallel across files would race on the same companyId.
    fileParallelism: false,
    // Most tests are pure; a small handful hit Postgres. 30s is generous for
    // the latter without inviting hanging suites.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
