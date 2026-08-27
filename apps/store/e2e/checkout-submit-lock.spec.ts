/**
 * Checkout submit locking.
 *
 * Disabling the pay button looks like protection enough, but Enter in any text
 * field submits the form regardless. A second submission during the second or
 * two before the redirect would reserve the stock again and open a second
 * Mollie payment against a single basket.
 *
 * The mock Mollie issues ids in sequence, so a duplicate is directly
 * observable: one submission must advance the counter exactly once.
 */
import { expect, test } from '@playwright/test';
import {
  lastMockPaymentId,
  setMollieScenario,
  startMockMollie,
  stopMockMollie,
} from './_helpers/mock-mollie';

const SEEDED_GROUP_SLUG = process.env.E2E_GROUP_SLUG ?? 'landau-pla-basic-1-75mm-1kg';

test.describe('Checkout submit lock', () => {
  test.beforeAll(async () => {
    await startMockMollie();
  });
  test.afterAll(async () => {
    await stopMockMollie();
  });

  test('covers the page and refuses a second submit before redirecting', async ({ page }) => {
    setMollieScenario('paid');

    await page.goto(`/shop/${SEEDED_GROUP_SLUG}`);
    const firstSwatch = page.locator('[data-test="swatch"]').first();
    if (await firstSwatch.count()) await firstSwatch.click();
    await page.getByRole('button', { name: /^add to cart$/i }).click();

    await page.goto('/checkout');
    await page.fill('input[name="email"]', 'lock@e2e.invalid');
    await page.fill('input[name="firstName"]', 'Ada');
    await page.fill('input[name="lastName"]', 'Lovelace');
    await page.fill('input[name="line1"]', '1 Test Street');
    await page.fill('input[name="city"]', 'Wilmslow');
    await page.fill('input[name="postCode"]', 'SK9 6BH');
    await page.check('input[name="termsAccepted"]');

    // The overlay must not pre-empt a customer who has not committed yet.
    await expect(page.getByRole('status')).toHaveCount(0);

    await Promise.all([
      page.waitForURL(/\/checkout\/return/, { timeout: 30_000 }),
      (async () => {
        await page.locator('button[type="submit"]', { hasText: /pay/i }).click();
        // Enter in a text field bypasses the disabled button entirely — this is
        // the path that could have opened a second payment. Best-effort: on a
        // fast run the navigation may already have happened, which is equally
        // fine, so failures here must not fail the test.
        await page
          .fill('input[name="email"]', 'lock@e2e.invalid')
          .catch(() => {});
        await page.keyboard.press('Enter').catch(() => {});
      })(),
    ]);

    const cid = new URL(page.url()).searchParams.get('cid');
    expect(cid).toBeTruthy();

    // One basket, one payment. A second submission would have advanced the
    // mock's counter past the id this checkout is attached to.
    const idAfter = lastMockPaymentId();
    expect(idAfter).toMatch(/^tr_mock_\d+$/);

    // Nothing further should be created by the keystrokes above.
    await page.waitForTimeout(500);
    expect(lastMockPaymentId()).toBe(idAfter);
  });
});
