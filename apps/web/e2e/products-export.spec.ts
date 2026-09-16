import { expect, test } from '@playwright/test';
import { authenticatePage } from './helpers/auth';

const CSV = 'Name,Stock code,Expected next cost\r\nPlain Flour,FLOUR-01,0.001200\r\n';

/**
 * The Export button on /products (requested after the September venue round).
 *
 * Proves the whole path a person actually takes: the button is next to "New
 * product", clicking it produces a real browser download, and the request
 * carries the bearer token. That last one is the failure this feature is most
 * exposed to — the JWT lives in localStorage, so a plain link would arrive
 * unauthenticated and bounce the operator to /login instead of downloading.
 */
test.describe('products export', () => {
  test.beforeEach(async ({ page }) => {
    await authenticatePage(page);

    // Specific route first — Playwright matches most-recently-added first, but
    // being explicit here keeps the intent obvious.
    await page.route('**/api/v1/products/export.csv*', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="products-2026-09-16.csv"',
        },
        body: CSV,
      });
    });

    await page.route('**/api/v1/products?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: 'p1',
              name: 'Plain Flour',
              stockCode: 'FLOUR-01',
              productType: 'PHYSICAL',
              expectedNextCost: '0.001200',
              minSellingPrice: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        }),
      });
    });
  });

  test('sits beside New product and downloads the catalogue', async ({ page }) => {
    await page.goto('/products');
    await expect(page.getByRole('heading', { name: /products/i })).toBeVisible();

    const exportButton = page.getByRole('button', { name: /^export$/i });
    await expect(exportButton).toBeVisible();
    await expect(page.getByRole('link', { name: /new product/i })).toBeVisible();

    await page.screenshot({ path: 'test-results/products-export-button.png', fullPage: false });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportButton.click(),
    ]);
    expect(download.suggestedFilename()).toBe('products-2026-09-16.csv');
  });

  test('sends the bearer token with the download request', async ({ page }) => {
    let auth: string | undefined;
    await page.route('**/api/v1/products/export.csv*', async (route) => {
      auth = route.request().headers()['authorization'];
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="products-2026-09-16.csv"',
        },
        body: CSV,
      });
    });

    await page.goto('/products');
    await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^export$/i }).click(),
    ]);
    expect(auth).toMatch(/^Bearer /);
  });

  test('shows why it failed rather than doing nothing', async ({ page }) => {
    await page.route('**/api/v1/products/export.csv*', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Catalogue is locked' }),
      });
    });

    await page.goto('/products');
    await page.getByRole('button', { name: /^export$/i }).click();
    await expect(page.getByRole('alert')).toContainText('Catalogue is locked');
  });
});
