/**
 * Rejected submissions on a real venue viewport (Aug-2026 feedback set, A-1).
 *
 * The API is stubbed to a 400 so this runs without a live server: the point of
 * the spec is what the *screen* does with a refusal, which is the thing the
 * 12 Aug session got wrong.
 */
import { expect, test } from '@playwright/test';
import { gotoVenueScreen } from './helpers/touch';

const PRODUCT = {
  id: 'prod-icing',
  name: 'Icing sugar',
  stockCode: 'ING-ICING',
  barcode: '5012345678900',
  stockUom: 'g',
  purchaseUom: 'sack',
  purchaseToStockFactor: '25000',
  expectedNextCost: '0.0012',
  requireBatchNumber: false,
};

test.describe('goods-in rejection keeps the work on screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/products**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [PRODUCT], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
      }),
    );
    // `/sites` is a plain (non-paginated) list — the envelope must not carry
    // total/page, or apiFetch unwraps it as a PaginatedResult and `sites` is
    // an object, not an array.
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
  });

  test('A-1: a 400 shows the error banner and the line survives', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn');

    await page.getByLabel(/product code/i).fill('5012345678900');
    await page.getByRole('button', { name: /\+ add/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();

    await page.route('**/api/v1/goods-in', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Site London South has no open receiving bay' }),
      }),
    );

    await page.getByRole('button', { name: /book in 1 line/i }).click();

    await expect(page.getByRole('alert')).toContainText(/no open receiving bay/i);
    // The line is still there — nothing was cleared and nothing claims success.
    await expect(page.getByText('Icing sugar')).toBeVisible();
    await expect(page.getByText(/saved offline/i)).toHaveCount(0);
  });
});
