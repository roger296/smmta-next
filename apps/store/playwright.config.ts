/**
 * Playwright config — drives the Filament Store storefront end-to-end.
 *
 * Unlike the Vitest unit / integration tests which mock Mollie + the
 * SMMTA API at the module boundary, Playwright drives the **real**
 * storefront (Next 15 production server on :3000) against the
 * **real** SMMTA-NEXT API (Fastify on :8080) against a real Postgres.
 *
 * Mollie hosted-checkout is mocked at the network layer in each
 * test (see e2e/_helpers/mock-mollie.ts) — Mollie's UI is not a
 * stable test surface and we don't want every CI run to depend on
 * api.mollie.com being up. SendGrid runs in sandbox mode (no real
 * deliveries) for the same reason.
 *
 * The CI workflow (.github/workflows/e2e.yml) sets up Postgres,
 * boots both apps, seeds a published catalogue, then runs `npx
 * playwright test` against this config. Local runs work too once
 * `docker-compose up -d` is running and both apps are started.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.STORE_PORT ?? 3000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Tests are isolated by per-cookie cart, so they CAN run in parallel,
  // but each one will start a fresh checkout — be conservative locally
  // and serial in CI to keep the SMMTA reservation table tidy.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // Generous timeouts: a checkout flow drives multiple server round-
  // trips through reservation create + Mollie create + commit.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
