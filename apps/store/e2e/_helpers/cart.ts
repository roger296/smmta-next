import { expect, type Page } from '@playwright/test';

/**
 * Add the currently-selected variant to the basket and wait for it to
 * land.
 *
 * Every checkout spec needs this, and every one of them previously
 * inlined its own copy of the wait. When the confirmation moved from a
 * button-label change ("Added ✓") to a separate `role="status"` element,
 * one spec was updated and three were missed — the suite went red on a
 * change that was otherwise correct. One helper, one place to update.
 *
 * The wait matters: add-to-cart fires a fetch and does NOT navigate.
 * Navigating early leaves the basket empty, and /checkout then bounces
 * straight back to /cart with no form on it, which fails several steps
 * later with a confusing error.
 */
export async function addSelectedVariantToCart(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^add to cart$/i }).click();
  await expect(page.getByRole('status').filter({ hasText: /added/i })).toBeVisible({
    timeout: 5_000,
  });
}

/**
 * Pick the first colour swatch if the page has one.
 *
 * Standalone products have no swatch picker, so this is a no-op there
 * rather than a failure.
 */
export async function selectFirstSwatchIfPresent(page: Page): Promise<void> {
  const swatch = page.locator('[data-test="swatch"]').first();
  if ((await swatch.count()) > 0) await swatch.click();
}
