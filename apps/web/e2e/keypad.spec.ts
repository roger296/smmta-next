/**
 * Number entry with a physical keyboard (Aug-2026 feedback set, D-4 / D-5).
 *
 * "Default numbers are not overridden when typing (entering '3' into a default
 * field of '1' results in '13')."
 * "Request to enable direct number pad typing on laptop keyboards."
 *
 * The 12 Aug session used a laptop as well as the iPad, so this runs on the
 * desktop project too — it is the laptop half of the report.
 */
import { expect, test } from '@playwright/test';
import { gotoVenueScreen } from './helpers/touch';

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

test.describe('goods-in quantity keypad', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/products/by-code/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: ICING }),
      }),
    );
    await gotoVenueScreen(page, 'goodsIn');
    await page.getByLabel(/product code/i).fill('5012345678900');
    await page.getByRole('button', { name: /\+ add/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();
  });

  test('D-4 REGRESSION: type 3 on the physical keyboard, Enter — the line reads 3, not 13', async ({
    page,
  }) => {
    // The line starts at 1, which is exactly the default the tester typed over.
    await page.getByRole('button', { name: /type received quantity/i }).click();
    await expect(page.getByRole('status')).toHaveText('1');
    await expect(page.getByText('was 1')).toBeVisible();

    await page.keyboard.type('3');
    await expect(page.getByRole('status')).toHaveText('3');

    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: /type received quantity/i })).toHaveText('3');
    await expect(page.locator('.touch-app .row .hint')).toContainText('3 × 25 kg sack = 75 kg');
  });

  test('D-5: a multi-digit quantity types straight in', async ({ page }) => {
    await page.getByRole('button', { name: /type received quantity/i }).click();
    await page.keyboard.type('12');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /type received quantity/i })).toHaveText('12');
  });

  test('D-5: Escape cancels and leaves the quantity alone', async ({ page }) => {
    await page.getByRole('button', { name: /type received quantity/i }).click();
    await page.keyboard.type('99');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /type received quantity/i })).toHaveText('1');
  });

  test('D-5: Backspace on the pristine default clears it', async ({ page }) => {
    await page.getByRole('button', { name: /type received quantity/i }).click();
    await page.keyboard.press('Backspace');
    await expect(page.getByRole('status')).toHaveText('0');
    // Nothing to save until a number is entered.
    await expect(page.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });
});
