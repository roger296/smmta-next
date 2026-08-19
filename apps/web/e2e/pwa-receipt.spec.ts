/**
 * The booking receipt on a venue iPad (Aug-2026 feedback set, A-5).
 *
 * "Request clear visual feedback upon booking rather than having items
 * immediately clear from view."
 */
import { expect, test } from '@playwright/test';
import { gotoVenueScreen, TEST_VENUE } from './helpers/touch';

const ICING = {
  id: 'prod-icing',
  name: 'Icing sugar',
  stockCode: 'ING-ICING',
  barcode: '5012345678900',
  stockUom: 'g',
  purchaseUom: 'sack',
  packDescription: '25 kg sack',
  purchaseToStockFactor: '25000',
  expectedNextCost: '30.000000',
  requireBatchNumber: false,
};

test.describe('book, see the receipt, book another', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/products/by-code/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: ICING }),
      }),
    );
    await page.route('**/api/v1/goods-in', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            receipt: {
              id: 'receipt-1',
              siteId: TEST_VENUE.id,
              reference: 'GRN-0042',
              totalStockValue: '120.00',
              receivedAt: '2026-08-19T10:00:00.000Z',
            },
            lines: [],
            alreadyExisted: false,
          },
        }),
      }),
    );
  });

  test('A-5: booking shows a receipt, and "Book another" gives an empty form', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn');
    await page.getByLabel(/product code/i).fill('5012345678900');
    await page.getByRole('button', { name: /\+ add/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();
    for (let i = 0; i < 3; i += 1) {
      await page.getByRole('button', { name: /add one sack of Icing sugar/i }).click();
    }

    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();

    // The list did NOT vanish — it is restated as a receipt.
    await expect(page.locator('.receipt-title')).toHaveText(`Booked to ${TEST_VENUE.name}`);
    await expect(page.locator('.receipt-sub')).toContainText('GRN-0042');
    await expect(page.getByText('4 × 25 kg sack = 100 kg')).toBeVisible();
    await expect(page.locator('.receipt-total')).toContainText('£120.00');

    await page.getByRole('button', { name: /book another delivery/i }).click();

    await expect(page.getByLabel(/product code/i)).toBeVisible();
    await expect(page.getByText('Icing sugar')).toHaveCount(0);
  });

  test('A-5: Back with unbooked lines prompts before discarding', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn');
    await page.getByLabel(/product code/i).fill('5012345678900');
    await page.getByRole('button', { name: /\+ add/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();

    await page.getByRole('button', { name: /^back$/i }).click();
    await expect(page.getByText('Leave without booking in?')).toBeVisible();

    await page.getByRole('button', { name: /keep editing/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();
    await expect(page).toHaveURL(/\/pwa\/goods-in$/);
  });
});
