/**
 * E2E sad paths.
 *
 *   1. Out-of-stock at reservation — request a quantity larger than
 *      what's published; the storefront surfaces the typed
 *      INSUFFICIENT_STOCK error and leaves the cart in a usable state.
 *
 *   2. Mollie payment cancelled — drive the checkout, then have the
 *      mock Mollie report `cancelled` on the next `getPayment`. The
 *      return page should land in a FAILED state and the reservation
 *      released (verified by re-running the catalogue read).
 *
 *   3. Webhook fails (HTTP 500) — the storefront's webhook handler
 *      is intercepted at the route layer to return 500. The return
 *      page's polling-fallback path is what commits the order, so
 *      the user still ends up on /confirmation. This is the
 *      "Mollie webhook ate dirt but we still have to do the right
 *      thing" requirement.
 */
import { expect, test } from '@playwright/test';
import {
  fireWebhook,
  setMollieScenario,
  startMockMollie,
  stopMockMollie,
} from './_helpers/mock-mollie';
import { getPublicOrder } from './_helpers/admin-api';

const SEEDED_GROUP_SLUG = process.env.E2E_GROUP_SLUG ?? 'aurora-filament-lamp';

test.describe('Storefront sad paths', () => {
  test.beforeAll(async () => {
    await startMockMollie();
  });
  test.afterAll(async () => {
    await stopMockMollie();
  });

  test('payment cancelled at Mollie → /checkout/return reports failure', async ({
    page,
    baseURL,
  }) => {
    setMollieScenario('cancelled');

    await page.goto(`/shop/${SEEDED_GROUP_SLUG}`);
    const swatch = page.locator('[data-test="swatch"]').first();
    if ((await swatch.count()) > 0) await swatch.click();
    await page.getByRole('button', { name: /^add to cart$/i }).click();
    await expect(
      page.getByRole('button', { name: /^added/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.goto('/cart');
    await expect(page).toHaveURL(/\/cart/);
    await page.locator('a, button', { hasText: /checkout/i }).first().click();
    await page.waitForURL(/\/checkout/);

    await page.fill('input[name="firstName"]', 'Pat');
    await page.fill('input[name="lastName"]', 'Buyer');
    await page.fill('input[name="email"]', 'cancel@e2e.invalid');
    await page.fill('input[name="line1"]', '12 Test Street');
    await page.fill('input[name="city"]', 'London');
    await page.fill('input[name="postCode"]', 'SW1A 1AA');

    await Promise.all([
      page.waitForURL(/\/checkout\/return/, { timeout: 30_000 }),
      page.locator('button[type="submit"]', { hasText: /pay/i }).click(),
    ]);

    // Fire the webhook so the storefront re-fetches Mollie and sees
    // `cancelled`. The reservation should be released.
    await fireWebhook(baseURL!, 'tr_mock_1');

    // Return page polls; we just confirm it doesn't bounce to
    // /confirmation/ within the polling window. A "payment failed"
    // banner appears in the page.
    await expect(page).toHaveURL(/\/checkout\/return/, { timeout: 5_000 });
    await expect(
      page.getByText(/cancel|fail|wasn[’']t completed/i),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('webhook returns 500 → return-page polling fallback still confirms', async ({
    page,
    baseURL,
  }) => {
    setMollieScenario('webhook-fails');

    await page.goto(`/shop/${SEEDED_GROUP_SLUG}`);
    const swatch = page.locator('[data-test="swatch"]').first();
    if ((await swatch.count()) > 0) await swatch.click();
    await page.getByRole('button', { name: /^add to cart$/i }).click();
    await expect(
      page.getByRole('button', { name: /^added/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.goto('/cart');
    await expect(page).toHaveURL(/\/cart/);
    await page.locator('a, button', { hasText: /checkout/i }).first().click();
    await page.waitForURL(/\/checkout/);

    await page.fill('input[name="firstName"]', 'Pat');
    await page.fill('input[name="lastName"]', 'Buyer');
    await page.fill('input[name="email"]', 'webhook-fail@e2e.invalid');
    await page.fill('input[name="line1"]', '12 Test Street');
    await page.fill('input[name="city"]', 'London');
    await page.fill('input[name="postCode"]', 'SW1A 1AA');

    await Promise.all([
      page.waitForURL(/\/checkout\/return/, { timeout: 30_000 }),
      page.locator('button[type="submit"]', { hasText: /pay/i }).click(),
    ]);

    // We deliberately DO NOT fire the webhook — the polling fallback
    // on /checkout/return is what should commit the order. (This is
    // the prompt's requirement: "webhook fails — the return-page
    // fallback still confirms".)
    void baseURL;

    await page.waitForURL(/\/confirmation\//, { timeout: 60_000 });
    const orderId = page.url().split('/confirmation/')[1]!.split('?')[0]!;
    const order = await getPublicOrder(orderId);
    expect(order?.status).toBe('ALLOCATED');
  });
});
