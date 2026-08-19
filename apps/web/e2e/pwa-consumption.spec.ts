/**
 * End of Bake on a venue iPad (Aug-2026 feedback set, F-1 / F-2 / F-3 / F-7).
 *
 * "'Table +' and 'Table -' buttons are reversed when switching to 'What's
 *  Left' mode."
 * "Toggling to 'What's Left' resets the counter to 0, but toggling back does
 *  not reset it back."
 * "Request to show benches under the kilo figures."
 */
import { expect, test } from '@playwright/test';
import { gotoVenueScreen, TEST_VENUE } from './helpers/touch';

const RECIPE_LINES = [
  {
    productId: 'prod-flour',
    productName: 'Plain flour',
    stockUom: 'g',
    expectedQty: 500,
    qtyPerCover: 100,
  },
];

async function stubRecipe(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/recipes/coverage', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { hasRecipe: true, glutenFree: true, vegan: true },
      }),
    }),
  );
  await page.route('**/api/v1/recipes/bakes', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: ['Battenburg'] }),
    }),
  );
  await page.route('**/api/v1/recipes/expected', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // F-6: the endpoint returns lines PLUS the reasons a bake cannot be
      // filed, so an empty list is never mistaken for "nothing to record".
      body: JSON.stringify({ success: true, data: { lines: RECIPE_LINES, blockers: [] } }),
    }),
  );
}

/** Fill the setup screen and load the ingredient list. */
async function loadIngredients(page: import('@playwright/test').Page, tables = 5) {
  await page.getByRole('button', { name: 'Battenburg' }).click();
  await page.getByRole('button', { name: /number of regular tables/i }).click();
  await page.keyboard.type(String(tables));
  await page.getByRole('button', { name: /^save$/i }).click();
  await page.getByLabel(/session id/i).fill('SESSION-1');
  await page.getByLabel(/your name/i).fill('Test Baker');
  await page.getByRole('button', { name: /load ingredients/i }).click();
  await expect(page.getByText('Plain flour')).toBeVisible();
}

/** The venue has told us its bench ratio (F-7). */
const VENUE_WITH_BENCHES = [{ ...TEST_VENUE, isActive: true, benchesPerTable: '6.00' }];

test.describe('End of Bake', () => {
  test.beforeEach(async ({ page }) => {
    await stubRecipe(page);
  });

  test('F-2 REGRESSION: toggling to What\'s Left and back keeps the figure', async ({ page }) => {
    await gotoVenueScreen(page, 'consumption', { sites: VENUE_WITH_BENCHES });
    await loadIngredients(page);

    const value = page.getByRole('button', { name: /type amount of Plain flour used/i });
    await expect(value).toHaveText('500');

    await page.getByRole('button', { name: /entering: amount used/i }).click();
    // A fresh, explicit question — seeded 0.
    await expect(page.getByRole('button', { name: /type what is left of Plain flour/i })).toHaveText('0');

    await page.getByRole('button', { name: /entering: what's left/i }).click();
    // Pre-F12 this came back as 0, and the variance badge read −500.
    await expect(page.getByRole('button', { name: /type amount of Plain flour used/i })).toHaveText('500');
  });

  test('F-1 REGRESSION: in What\'s Left mode, +1 table left INCREASES the number', async ({ page }) => {
    await gotoVenueScreen(page, 'consumption', { sites: VENUE_WITH_BENCHES });
    await loadIngredients(page);

    await page.getByRole('button', { name: /entering: amount used/i }).click();
    const value = page.getByRole('button', { name: /type what is left of Plain flour/i });
    await expect(value).toHaveText('0');

    // Pre-F12 "Table+" DECREASED remainingQty while "+" increased it.
    await page.getByRole('button', { name: /add one table left of Plain flour/i }).click();
    await expect(value).toHaveText('100');
    await page.getByRole('button', { name: /increase Plain flour/i }).click();
    await expect(value).toHaveText('101');

    await page.getByRole('button', { name: /remove one table left of Plain flour/i }).click();
    await expect(value).toHaveText('1');
  });

  test('F-3: the table count between the buttons tracks the quantity', async ({ page }) => {
    await gotoVenueScreen(page, 'consumption', { sites: VENUE_WITH_BENCHES });
    await loadIngredients(page, 5);

    // 500 g at 100 g/table = 5 tables, of a 5-table session.
    await expect(page.locator('.table-count')).toHaveText('5 / 5');

    await page.getByRole('button', { name: /add one table of Plain flour/i }).click();
    // Pre-F12 this number was the session total and never moved.
    await expect(page.locator('.table-count')).toHaveText('6 / 5');
  });

  test('F-7: benches are shown under the figures', async ({ page }) => {
    await gotoVenueScreen(page, 'consumption', { sites: VENUE_WITH_BENCHES });
    await loadIngredients(page, 5);

    // 5 tables × 6 benches.
    await expect(page.locator('.hint.benches')).toContainText('≈ 30 benches');
    await expect(page.locator('.topbar')).toContainText('≈ 30 benches');
  });

  test('F-7: a venue with no bench setting says so rather than guessing', async ({ page }) => {
    await gotoVenueScreen(page, 'consumption', {
      sites: [{ ...TEST_VENUE, isActive: true, benchesPerTable: null }],
    });
    await loadIngredients(page, 5);

    await expect(page.locator('.hint.benches')).toContainText('benches not set for this venue');
  });

  test('F-8: an uncounted What\'s Left line blocks the submit', async ({ page }) => {
    await gotoVenueScreen(page, 'consumption', { sites: VENUE_WITH_BENCHES });
    await loadIngredients(page);

    await page.getByRole('button', { name: /entering: amount used/i }).click();
    // The row says so...
    await expect(page.locator('.badge.warn', { hasText: 'not counted yet' })).toBeVisible();
    // ...and the submit refuses, naming how many.
    await expect(page.getByRole('button', { name: /1 line not counted yet/i })).toBeDisabled();
  });
});
