/**
 * Stock-take on a venue iPad (Aug-2026 feedback set, D-1 / D-3).
 *
 * "Every row read as a raw alphanumeric string, so no count could be logged."
 * The API is stubbed against a seeded-shaped fixture; the product-map endpoint
 * is deliberately broken, because a legible count sheet must not depend on it.
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
    },
    {
      productId: '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      bookQty: '9600',
      productName: 'Skittles',
      stockCode: 'ING-SKITTLE',
      stockUom: 'g',
      itemKind: 'INGREDIENT',
    },
  ],
};

test.describe('stock-take shows product names', () => {
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
    // The supplementary lookup is broken on purpose — see the header.
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

  test('D-1: the first row is a real product name, not a hex fragment', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake');
    await page.getByRole('button', { name: /start count/i }).click();

    const firstLabel = page.locator('.touch-app .row .name').first();
    await expect(firstLabel).toHaveText('Icing sugar');
    await expect(firstLabel).not.toHaveText(/^[0-9a-f]{8}$/);
  });

  test('D-3: search finds a row by its stock code', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake');
    await page.getByRole('button', { name: /start count/i }).click();
    await expect(page.getByText('Skittles')).toBeVisible();

    await page.getByPlaceholder(/search items/i).fill('ING-SKITTLE');
    await expect(page.getByText('Skittles')).toBeVisible();
    await expect(page.getByText('Icing sugar')).toHaveCount(0);
  });
});
