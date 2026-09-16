/**
 * The count instruction on the stock-take row (Sept-2026 request).
 *
 * Replaces the old "Book: N uom" sub-line. The product map is stubbed BROKEN
 * on purpose, as in pwa-stock-take.spec.ts: the instruction has to travel on
 * the take line, or a failing lookup would quietly downgrade head office's own
 * wording to the generic sentence with nothing to say it had.
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
      stockCheckInstruction: null,
    },
    {
      productId: '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      bookQty: '12',
      productName: 'Bacardi Gold Rum',
      stockCode: 'BACA-GOLD-RUM',
      stockUom: 'bottle',
      itemKind: 'RETAIL',
      stockCheckInstruction: null,
    },
    {
      productId: '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      bookQty: '40',
      productName: 'Plain Flour',
      stockCode: 'BAKE-PLAI-FLOU',
      stockUom: 'kg',
      itemKind: 'INGREDIENT',
      stockCheckInstruction: 'Weigh the open sack, do not count it',
    },
  ],
};

test.describe('stock-take count instruction', () => {
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
    // Broken on purpose — the instruction must not depend on this.
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

  test('spells the unit out, or shows the product instruction instead', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake');
    await page.getByRole('button', { name: /start count/i }).click();

    const instructions = page.locator('.touch-app .row .count-instruction');
    await expect(instructions).toHaveCount(3);
    await expect(instructions.nth(0)).toHaveText('Count this item in grams');
    await expect(instructions.nth(1)).toHaveText('Count this item in bottles');
    // Head office wrote this one, so it wins over the generic sentence.
    await expect(instructions.nth(2)).toHaveText('Weigh the open sack, do not count it');

    await page.screenshot({ path: 'test-results/stock-take-instruction.png' });
  });

  test('the book figure is gone from the row', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake');
    await page.getByRole('button', { name: /start count/i }).click();

    await expect(page.locator('.touch-app .row').first()).not.toContainText('Book:');
    await expect(page.getByText('4000')).toHaveCount(0);
    // The stock code stays — it is how a counter tells two similar items apart.
    await expect(page.locator('.touch-app .row').first()).toContainText('ING-ICING');
  });

  // The comparison is useful AFTER a number is entered, not before it.
  test('variance still appears once a count is entered', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake');
    await page.getByRole('button', { name: /start count/i }).click();

    const firstRow = page.locator('.touch-app .row').first();
    await firstRow.getByRole('button', { name: 'Set to zero' }).click();
    await expect(firstRow.locator('.badge.warn')).toContainText('Δ -4000');
  });

  test('it reads larger than the small print it replaced', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake');
    await page.getByRole('button', { name: /start count/i }).click();

    const instructionSize = await page
      .locator('.touch-app .row .count-instruction')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const hintSize = await page
      .locator('.touch-app .row .hint')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(instructionSize).toBeGreaterThan(hintSize);
    expect(instructionSize).toBeGreaterThanOrEqual(15);
  });
});
