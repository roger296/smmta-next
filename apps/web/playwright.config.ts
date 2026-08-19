import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright projects (Aug-2026 feedback set, F1).
 *
 * The 12 Aug venue test ran on an iPad in BOTH orientations, and the worst
 * defect (B-1 — the top of the screen cut off and uneditable) only reproduces
 * at a tablet viewport with a soft keyboard. So the desktop project is no
 * longer enough: `ipad-portrait` and `ipad-landscape` run the venue specs at
 * the real device metrics.
 *
 * Honest limitation: Playwright drives Chromium, not WebKit-on-iOS. These
 * projects catch layout, focus and hit-testing regressions; they do NOT
 * reproduce iOS Safari's own keyboard / visual-viewport behaviour. The manual
 * retest script (docs/RETEST_2026-08-12.md, F15) remains the final check on a
 * real iPad.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // Was `chromium`; renamed to `desktop` now that there are three
      // projects and "which browser" is no longer the distinguishing axis.
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'ipad-portrait',
      use: { ...devices['iPad Pro 11'] },
    },
    {
      name: 'ipad-landscape',
      use: { ...devices['iPad Pro 11 landscape'] },
    },
  ],
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
