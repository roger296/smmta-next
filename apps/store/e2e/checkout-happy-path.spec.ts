/**
 * E2E happy path: home → group → add to cart → checkout → mock pay →
 * confirmation → /track shows ALLOCATED.
 *
 * The Mollie hosted-checkout is replaced by the in-test mock server
 * (see e2e/_helpers/mock-mollie.ts) so the run is deterministic and
 * doesn't depend on api.mollie.com. The CI workflow points the
 * storefront at the mock via `MOLLIE_API_BASE_URL` before booting.
 *
 * The test relies on the `seed:storefront` script having seeded a
 * published group + at least one in-stock variant. The CI workflow
 * runs the seed before Playwright.
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

test.describe('Storefront happy path', () => {
  test.beforeAll(async () => {
    await startMockMollie();
  });
  test.afterAll(async () => {
    await stopMockMollie();
  });

  test('add to cart → mock-pay → confirmation → /track shows ALLOCATED', async ({
    page,
    baseURL,
  }) => {
    setMollieScenario('paid');

    // ---------------- 1. Home → Shop → Group ---------------------
    await page.goto('/');
    await expect(page.locator('h1')).toContainText(/light/i);
    await page.goto(`/shop/${SEEDED_GROUP_SLUG}`);
    await expect(page).toHaveURL(new RegExp(`/shop/${SEEDED_GROUP_SLUG}`));

    // ---------------- 2. Pick a colour (if multi-variant) --------
    // The swatch picker is keyboard-accessible; we just click the first
    // colour swatch. If the seeded group has only one variant the
    // picker won't appear — that's fine, the add-to-cart still works.
    const firstSwatch = page.locator('[data-test="swatch"]').first();
    if ((await firstSwatch.count()) > 0) {
      await firstSwatch.click();
    }

    // ---------------- 3. Add to cart ------------------------------
    // The Add-to-Cart control is a `type="button"` that fires a fetch
    // and toggles to "Added ✓"; it does NOT navigate. Use the role +
    // accessible name to find it, wait for the success label so we know
    // the mutation completed, then drive the navigation ourselves.
    await page.getByRole('button', { name: /^add to cart$/i }).click();
    await expect(
      page.getByRole('button', { name: /^added/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.goto('/cart');
    await expect(page).toHaveURL(/\/cart/);

    // ---------------- 4. Checkout ---------------------------------
    await page.locator('a, button', { hasText: /checkout/i }).first().click();
    await expect(page).toHaveURL(/\/checkout/);

    // ---------------- 5. Fill the address form --------------------
    await page.fill('input[name="firstName"]', 'Pat');
    await page.fill('input[name="lastName"]', 'Buyer');
    await page.fill('input[name="email"]', 'buyer@e2e.invalid');
    await page.fill('input[name="line1"]', '12 Test Street');
    await page.fill('input[name="city"]', 'London');
    await page.fill('input[name="postCode"]', 'SW1A 1AA');
    // Country defaults to GB; if there's a select on the page, pick GB.
    const country = page.locator('select[name="country"]');
    if ((await country.count()) > 0) {
      await country.selectOption('GB');
    }

    // ---------------- 6. Pay --------------------------------------
    // Submitting the form posts to /api/checkout/start which redirects
    // to Mollie. Our mock Mollie's checkoutUrl points back at
    // /checkout/return immediately, so the navigation chain ends on
    // the return page.
    // Tick the terms-and-conditions checkbox — the form's onSubmit handler
    // early-returns if termsAccepted is false, so the Pay click would
    // otherwise never navigate and the URL wait would time out.
    await page.check('input[name="termsAccepted"]');

    await Promise.all([
      page.waitForURL(/\/checkout\/return/, { timeout: 30_000 }),
      page.locator('button[type="submit"]', { hasText: /pay/i }).click(),
    ]);

    // ---------------- 7. Trigger the webhook explicitly ----------
    // In production Mollie does this; the mock doesn't. The return
    // page also has a polling fallback — we fire the webhook here
    // to exercise the primary path.
    const url = new URL(page.url());
    const cid = url.searchParams.get('cid');
    expect(cid).toBeTruthy();
    // The mock Mollie always assigns ids in order tr_mock_1, _2, ...
    // For the happy-path test there's only one in flight.
    await fireWebhook(baseURL!, 'tr_mock_1');

    // ---------------- 8. Confirmation page ------------------------
    await page.waitForURL(/\/confirmation\//, { timeout: 30_000 });
    const orderId = page.url().split('/confirmation/')[1]!.split('?')[0]!;
    expect(orderId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // ---------------- 9. SMMTA confirms ALLOCATED -----------------
    const order = await getPublicOrder(orderId);
    expect(order).not.toBeNull();
    expect(order!.status).toBe('ALLOCATED');

    // ---------------- 10. /track page renders ---------------------
    await page.goto(`/track/${orderId}`);
    await expect(page.locator('h1')).toContainText(/STORE-/);
    // The status timeline renders multiple stage labels ("Confirmed",
    // "Picked & packed", "Shipped", "Delivered"). The original regex
    // /Confirmed|Picked/i hit two elements, which Playwright's strict
    // mode rejects. Assert on the specific "Confirmed" label — that's
    // the canonical "order acknowledged" stage that's always present.
    await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  });
});
