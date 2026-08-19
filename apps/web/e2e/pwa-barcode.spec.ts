/**
 * Barcode and name search on a venue iPad (Aug-2026 feedback set, C-3).
 *
 * "Manual barcode entry failed to find the product for an icing sugar
 * delivery."
 */
import { expect, test } from '@playwright/test';
import { gotoVenueScreen } from './helpers/touch';

const ICING = {
  id: 'prod-icing',
  name: 'Icing sugar',
  stockCode: 'ING-ICING',
  barcode: '5012345678900',
  stockUom: 'g',
  purchaseUom: '25 kg sack',
  purchaseToStockFactor: '25000',
  expectedNextCost: '0.0012',
  requireBatchNumber: false,
};

const SKITTLES = {
  ...ICING,
  id: 'prod-skittles',
  name: 'Skittles',
  stockCode: 'ING-SKITTLE',
  barcode: '4009900484220',
  purchaseUom: '1.6 kg bag',
  purchaseToStockFactor: '1600',
};

test.describe('finding a product on Goods In', () => {
  test('C-3: typing a barcode resolves to exactly one product', async ({ page }) => {
    let byCodeCalls = 0;
    await page.route('**/api/v1/products/by-code/**', (route) => {
      byCodeCalls += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: ICING }),
      });
    });

    await gotoVenueScreen(page, 'goodsIn');
    await page.getByLabel(/product code/i).fill('5012345678900');
    await page.getByRole('button', { name: /\+ add/i }).click();

    await expect(page.locator('.touch-app .row .name')).toHaveText('Icing sugar');
    expect(byCodeCalls).toBe(1);
  });

  test('C-3: a miss offers a name search that returns a pickable list', async ({ page }) => {
    await page.route('**/api/v1/products/by-code/**', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'not found' }),
      }),
    );
    await page.route('**/api/v1/products?**', (route) => {
      const term = new URL(route.request().url()).searchParams.get('search') ?? '';
      // The unknown code finds nothing; the name finds both sugars.
      const data = /^\d+$/.test(term) ? [] : [ICING, SKITTLES];
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data, total: data.length, page: 1, pageSize: 50, totalPages: 1 }),
      });
    });

    await gotoVenueScreen(page, 'goodsIn');
    await page.getByLabel(/product code/i).fill('9999999999999');
    await page.getByRole('button', { name: /\+ add/i }).click();

    await expect(page.getByText('Nothing found for "9999999999999"')).toBeVisible();

    await page.getByLabel(/search products by name/i).fill('sugar');
    await page.getByRole('button', { name: /^search$/i }).click();

    // A pickable list, not a silent candidates[0].
    await expect(page.locator('.sheet .queue-item')).toHaveCount(2);
    await page.locator('.sheet .queue-item', { hasText: 'Icing sugar' }).getByRole('button', { name: /^add$/i }).click();

    await expect(page.locator('.touch-app .row .name')).toHaveText('Icing sugar');
  });
});
