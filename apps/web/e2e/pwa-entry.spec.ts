/**
 * PWA entry point (Aug-2026 feedback set, defects E-2 / E-6).
 *
 * "Adding the iPad PIN login page to the home screen redirects incorrectly to
 * the standard email login page."
 */
import { expect, test } from '@playwright/test';
import { authenticatePage } from './helpers/auth';
import { stubSites } from './helpers/touch';

/** Make the page believe it was launched from a home-screen icon. */
async function launchAsInstalledApp(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  });
}

test.describe('venue iPad entry', () => {
  test('E-2: an installed app opening / lands on the PIN screen', async ({ page }) => {
    await launchAsInstalledApp(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/pin-login$/);
    await expect(page.getByLabel('PIN')).toBeVisible();
  });

  test('E-2: a venue screen while signed out lands on the PIN screen, in a tab too', async ({ page }) => {
    await page.goto('/pwa/goods-in');
    await expect(page).toHaveURL(/\/pin-login/);
  });

  test('E-2: /login still renders the email form for office users', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test('E-2: a browser tab on / still gets the email form', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('E-2: the PIN screen offers an email fallback', async ({ page }) => {
    await page.goto('/pin-login');
    await page.getByRole('button', { name: /sign in with email instead/i }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('venue home', () => {
  test('E-2: signing in lands on the three-job venue home, not the dashboard', async ({ page }) => {
    await authenticatePage(page);
    await stubSites(page);
    await page.goto('/venue');

    await expect(page.locator('.touch-app')).toBeVisible();
    // Scoped to the tile grid: since F14 the venue rail carries the same three
    // job names, so an unscoped by-name query is ambiguous by design.
    const tiles = page.locator('.venue-jobs');
    await expect(tiles.getByRole('button', { name: /Goods In/ })).toBeVisible();
    await expect(tiles.getByRole('button', { name: /End of Bake/ })).toBeVisible();
    await expect(tiles.getByRole('button', { name: /Stock Take/ })).toBeVisible();
    // And it names the venue, like every other venue screen (B-5).
    await expect(page.locator('.touch-app .venue-chip')).toHaveText(/London South/);
    // No desktop chrome.
    await expect(page.getByRole('complementary', { name: /main navigation/i })).toHaveCount(0);
  });

  test('each tile opens its job', async ({ page }) => {
    await authenticatePage(page);
    await stubSites(page);
    await page.goto('/venue');
    await page.locator('.venue-jobs').getByRole('button', { name: /Goods In/ }).click();
    await expect(page).toHaveURL(/\/pwa\/goods-in$/);
  });
});
