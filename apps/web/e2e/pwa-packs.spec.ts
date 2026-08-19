/**
 * Booking real deliveries end to end (Aug-2026 feedback set, C-1/C-2/C-6).
 *
 * The two deliveries from the 12 Aug session, at both venue viewports:
 * 4 × 25 kg icing sugar, and 4 × 1.6 kg Skittles.
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

const SKITTLES = {
  ...ICING,
  id: 'prod-skittles',
  name: 'Skittles',
  stockCode: 'ING-SKITTLE',
  barcode: '4009900484220',
  purchaseUom: 'bag',
  packDescription: '1.6 kg bag',
  purchaseToStockFactor: '1600',
  expectedNextCost: '4.500000',
};

const BY_CODE: Record<string, typeof ICING> = {
  '5012345678900': ICING,
  '4009900484220': SKITTLES,
};

test.describe('the 12 Aug delivery, booked correctly', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/products/by-code/**', (route) => {
      const code = new URL(route.request().url()).pathname.split('/').pop() ?? '';
      const product = BY_CODE[decodeURIComponent(code)];
      if (!product) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'not found' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: product }),
      });
    });
  });

  test('C-1/C-2/C-6: 4 × 25 kg icing sugar and 4 × 1.6 kg Skittles', async ({ page }) => {
    const booked: Array<{ productId: string; qtyPurchase: number }> = [];
    await page.route('**/api/v1/goods-in', async (route) => {
      const body = route.request().postDataJSON() as {
        lines: Array<{ productId: string; qtyPurchase: number }>;
      };
      booked.push(...body.lines);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            receipt: {
              id: 'receipt-1',
              siteId: TEST_VENUE.id,
              reference: null,
              totalStockValue: '138.00',
              receivedAt: '2026-08-19T10:00:00.000Z',
            },
            lines: [],
            alreadyExisted: false,
          },
        }),
      });
    });

    await gotoVenueScreen(page, 'goodsIn');

    // Icing sugar — four sacks, stepped with the pack button (C-6).
    await page.getByLabel(/product code/i).fill('5012345678900');
    await page.getByRole('button', { name: /\+ add/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();
    const addSack = page.getByRole('button', { name: /add one sack of Icing sugar/i });
    await expect(addSack).toHaveText('+1 sack');
    for (let i = 0; i < 3; i += 1) await addSack.click();
    await expect(page.locator('.row', { hasText: 'Icing sugar' }).locator('.hint')).toContainText(
      '4 × 25 kg sack = 100 kg',
    );

    // Skittles — four 1.6 kg bags.
    await page.getByLabel(/product code/i).fill('4009900484220');
    await page.getByRole('button', { name: /\+ add/i }).click();
    await expect(page.getByText('Skittles')).toBeVisible();
    const addBag = page.getByRole('button', { name: /add one bag of Skittles/i });
    for (let i = 0; i < 3; i += 1) await addBag.click();
    await expect(page.locator('.row', { hasText: 'Skittles' }).locator('.hint')).toContainText(
      '4 × 1.6 kg bag = 6.4 kg',
    );

    // Neither line reads "= 1 g", which was the whole complaint.
    await expect(page.locator('.touch-app .row .hint').first()).not.toContainText('= 1 g');

    await page.getByRole('button', { name: /book in 2 lines/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();

    await expect
      .poll(() => booked)
      .toEqual([
        { productId: 'prod-icing', qtyPurchase: 4, unitCost: 30 },
        { productId: 'prod-skittles', qtyPurchase: 4, unitCost: 4.5 },
      ]);
  });
});
