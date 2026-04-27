import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config for @smmta/store.
 *
 * Pure unit tests live alongside source files. Anything that needs a real
 * Postgres or a live SMMTA API hits the docker-compose Postgres / running
 * API the same way apps/api's vitest does.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'dist'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
