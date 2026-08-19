/**
 * Performance sanity on a venue iPad (F15).
 *
 * The venue has one iPad and a queue of people behind whoever is holding it.
 * A count sheet at real catalogue size has to scroll and filter without the
 * person holding it wondering whether the tap registered.
 *
 * These are floors, not benchmarks — deliberately loose, so they fail on a
 * regression of the kind that makes a screen unusable rather than on the noise
 * of a shared CI box.
 */
import { expect, test } from '@playwright/test';
import { gotoVenueScreen } from './helpers/touch';
import { stubAug12 } from './helpers/aug12';

/** A realistic count sheet: more lines than the venue will ever count at once. */
const LINE_COUNT = 320;

function bigTake() {
  return {
    take: { id: 'take-big' },
    lines: Array.from({ length: LINE_COUNT }, (_, i) => ({
      // Deterministic uuid-shaped ids — no randomness, so a failure repeats.
      productId: `${String(i).padStart(8, '0')}-4e5f-4a6b-8c7d-9e0f1a2b3c4d`,
      bookQty: '4000',
      productName: i === 7 ? 'Icing sugar' : `Ingredient ${i}`,
      stockCode: i === 7 ? 'ING-ICING' : `ING-${String(i).padStart(4, '0')}`,
      stockUom: 'g',
      itemKind: 'INGREDIENT',
      countQuantum: null,
    })),
  };
}

test.describe(`a ${LINE_COUNT}-line count sheet`, () => {
  test.beforeEach(async ({ page }) => {
    await stubAug12(page);
    await page.route('**/api/v1/stock-takes', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: bigTake() }),
      }),
    );
  });

  test('renders every line, and search filters within 100ms', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake', { sites: false });
    await page.getByRole('button', { name: /start count/i }).click();
    await expect(page.locator('.touch-app .row').first()).toBeVisible();
    await expect(page.locator('.touch-app .row')).toHaveCount(LINE_COUNT);

    // Measure the filter itself: set the value, then let React re-render.
    const elapsed = await page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>('.touch-app .search')!;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      const start = performance.now();
      setter.call(input, 'ING-ICING');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - start;
    });

    await expect(page.locator('.touch-app .row')).toHaveCount(1);
    await expect(page.locator('.touch-app .row .name').first()).toHaveText('Icing sugar');
    expect(elapsed, `filtering ${LINE_COUNT} lines took ${Math.round(elapsed)}ms`).toBeLessThan(100);
  });

  test('scrolls to the bottom without losing the pinned chrome', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake', { sites: false });
    await page.getByRole('button', { name: /start count/i }).click();
    await expect(page.locator('.touch-app .row').first()).toBeVisible();

    await page.locator('.touch-app .scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('.touch-app .row').last()).toBeInViewport();

    // The topbar is sticky and the action bar is pinned: both must survive a
    // 320-line scroll, or a baker at the bottom of the sheet cannot save.
    const topbar = await page.locator('.touch-app .topbar').boundingBox();
    expect(topbar!.y).toBeGreaterThanOrEqual(0);
    await expect(page.getByRole('button', { name: /save counts/i })).toBeVisible();
  });

  test('a count typed at the bottom of the sheet still lands', async ({ page }) => {
    const counted: Array<{ productId: string; countedQty: number }> = [];
    await page.route('**/api/v1/stock-takes/*/counts', (route) => {
      const body = route.request().postDataJSON() as { counts: typeof counted };
      counted.push(...body.counts);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { recorded: body.counts.length } }),
      });
    });

    await gotoVenueScreen(page, 'stockTake', { sites: false });
    await page.getByRole('button', { name: /start count/i }).click();
    await page
      .getByPlaceholder(/search items/i)
      .fill(`ING-${String(LINE_COUNT - 1).padStart(4, '0')}`);

    const row = page.locator('.touch-app .row').first();
    await row.getByRole('button', { name: /type quantity/i }).click();
    await page.keyboard.type('4000');
    await page.getByRole('button', { name: /^save$/i }).click();
    await page.getByRole('button', { name: /save counts/i }).click();

    await expect.poll(() => counted.length).toBe(1);
    expect(counted[0]!.countedQty).toBe(4000);
  });
});
