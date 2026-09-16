/**
 * Category sections on the count sheet (Sept-2026 request).
 *
 * The behaviour worth protecting is that FOLDING IS NOT EXCLUDING: a count
 * entered in a section, then folded away, must still submit. Folding for
 * clarity that silently drops somebody's work would be the worst thing this
 * screen could do.
 */
import { expect, test } from '@playwright/test';
import { gotoVenueScreen } from './helpers/touch';

const TAKE = {
  take: { id: 'take-1' },
  lines: [
    {
      productId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      bookQty: '4000',
      productName: 'Icing sugar',
      stockCode: 'ING-ICING',
      stockUom: 'g',
      itemKind: 'INGREDIENT',
      itemCategoryName: 'Dry Stock',
    },
    {
      productId: '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      bookQty: '9600',
      productName: 'Plain Flour',
      stockCode: 'BAKE-PLAI-FLOU',
      stockUom: 'kg',
      itemKind: 'INGREDIENT',
      itemCategoryName: 'Dry Stock',
    },
    {
      productId: '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      bookQty: '12',
      productName: 'Bacardi Gold Rum',
      stockCode: 'BACA-GOLD-RUM',
      stockUom: 'bottle',
      itemKind: 'RETAIL',
      itemCategoryName: 'Bar',
    },
    {
      productId: '3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      bookQty: '3',
      productName: 'A4 Printer Paper',
      stockCode: 'A4-PAPER',
      stockUom: 'pack',
      itemKind: 'RETAIL',
      itemCategoryName: null,
    },
  ],
};

test.describe('count sheet sections', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/sites**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{ id: 'site-1', slug: 'london-south', name: 'London South', isActive: true }],
        }),
      }),
    );
    await page.route('**/api/v1/products?**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'boom' }),
      }),
    );
    await page.route('**/api/v1/stock-takes', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: TAKE }),
      }),
    );
  });

  async function open(page: import('@playwright/test').Page) {
    await gotoVenueScreen(page, 'stockTake');
    await page.getByRole('button', { name: /start count/i }).click();
  }

  test('splits the sheet by category, Uncategorised last', async ({ page }) => {
    await open(page);
    const heads = page.locator('.touch-app .count-section-name');
    await expect(heads).toHaveText(['Bar', 'Dry Stock', 'Uncategorised']);
    await page.screenshot({ path: 'test-results/stock-take-sections.png' });
  });

  test('each section shows its own progress', async ({ page }) => {
    await open(page);
    const dryStock = page.locator('.count-section', { hasText: 'Dry Stock' });
    await expect(dryStock.locator('.count-section-progress')).toHaveText('0 / 2');

    await dryStock.locator('.row').first().getByRole('button', { name: 'Set to zero' }).click();
    await expect(dryStock.locator('.count-section-progress')).toHaveText('1 / 2');
  });

  test('hiding a category folds its rows away', async ({ page }) => {
    await open(page);
    await expect(page.getByText('Bacardi Gold Rum')).toBeVisible();

    await page.locator('.count-section', { hasText: 'Bar' }).getByRole('button').first().click();
    await expect(page.getByText('Bacardi Gold Rum')).toBeHidden();
    // The other sections are untouched.
    await expect(page.getByText('Icing sugar')).toBeVisible();
    // And the header still says the section is there, and unfinished.
    await expect(
      page.locator('.count-section', { hasText: 'Bar' }).locator('.count-section-progress'),
    ).toHaveText('0 / 1');
  });

  test('more than one category can be hidden at once', async ({ page }) => {
    await open(page);
    await page.locator('.count-section', { hasText: 'Bar' }).getByRole('button').first().click();
    await page
      .locator('.count-section', { hasText: 'Uncategorised' })
      .getByRole('button')
      .first()
      .click();
    await expect(page.getByText('Bacardi Gold Rum')).toBeHidden();
    await expect(page.getByText('A4 Printer Paper')).toBeHidden();
    await expect(page.getByText('Icing sugar')).toBeVisible();
  });

  test('"Show all sections" brings them back in one tap', async ({ page }) => {
    await open(page);
    await page.locator('.count-section', { hasText: 'Bar' }).getByRole('button').first().click();
    await page.getByRole('button', { name: /show all sections/i }).click();
    await expect(page.getByText('Bacardi Gold Rum')).toBeVisible();
    await expect(page.getByRole('button', { name: /show all sections/i })).toBeHidden();
  });

  // The one that matters.
  test('a count in a HIDDEN section is still submitted', async ({ page }) => {
    const submitted: Array<{ productId: string; countedQty: number }> = [];
    await page.route('**/api/v1/stock-takes/*/counts**', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        counts?: Array<{ productId: string; countedQty: number }>;
      };
      submitted.push(...(body.counts ?? []));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      });
    });

    await open(page);
    // Count the rum, then fold the Bar away.
    const bar = page.locator('.count-section', { hasText: 'Bar' });
    await bar.locator('.row').first().getByRole('button', { name: 'Increase' }).click();
    await bar.getByRole('button').first().click();
    await expect(page.getByText('Bacardi Gold Rum')).toBeHidden();

    await page.getByRole('button', { name: /save counts/i }).click();
    await expect
      .poll(() => submitted.some((l) => l.productId === TAKE.lines[2]!.productId))
      .toBe(true);
  });

  test('the folded sections are remembered on this device', async ({ page }) => {
    await open(page);
    await page.locator('.count-section', { hasText: 'Bar' }).getByRole('button').first().click();
    await expect(page.getByText('Bacardi Gold Rum')).toBeHidden();

    await open(page);
    await expect(page.getByText('Bacardi Gold Rum')).toBeHidden();
    await expect(page.getByText('Icing sugar')).toBeVisible();
  });
});
