import { expect, test } from '@playwright/test';
import { authenticatePage } from './helpers/auth';

const PRODUCTS_JSON = {
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
};

async function stubList(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/products?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRODUCTS_JSON) }),
  );
}

test.describe('product CSV import', () => {
  test.beforeEach(async ({ page }) => {
    await authenticatePage(page);
    await stubList(page);
  });

  test('checks the file first, then imports on a separate press', async ({ page }) => {
    const calls: Array<{ dryRun: string | null; body: string }> = [];
    await page.route('**/api/v1/products/import*', (route) => {
      const url = new URL(route.request().url());
      const dryRun = url.searchParams.get('dryRun');
      calls.push({ dryRun, body: route.request().postData() ?? '' });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            dryRun: dryRun === 'true',
            created: 1,
            updated: 2,
            errors: [],
            ignoredColumns: ['Product ID'],
            unknownColumns: [],
            createdCategories: [],
            createdSample: ['NEW-01'],
            updatedSample: ['FLOUR-01'],
          },
        }),
      });
    });

    await page.goto('/products');
    await page.getByRole('button', { name: /^import$/i }).click();

    await page.getByLabel('CSV file').setInputFiles({
      name: 'products.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Name,Stock code\r\nPlain Flour,FLOUR-01\r\n'),
    });

    // Choosing the file runs a CHECK, not an import.
    await expect(page.getByText(/Ready — 1 to create, 2 to update/)).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.dryRun).toBe('true');
    expect(calls[0]?.body).toContain('FLOUR-01');
    await expect(page.getByText(/Read-only columns ignored: Product ID/)).toBeVisible();

    await page.screenshot({ path: 'test-results/product-import-check.png' });

    // The second press is the one that writes.
    await page.getByRole('button', { name: /^import$/i }).last().click();
    await expect(page.getByText(/Imported — 1 created, 2 updated/)).toBeVisible();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.dryRun).toBeNull();
  });

  test('shows every bad row instead of a bare failure', async ({ page }) => {
    await page.route('**/api/v1/products/import*', (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          data: {
            dryRun: true,
            created: 0,
            updated: 0,
            errors: [
              { row: 4, stockCode: 'F-9', message: 'Item category "Dry Stok" does not exist.' },
              { row: 7, stockCode: 'F-12', message: '"Expected next cost" is "lots", which is not a number.' },
            ],
            ignoredColumns: [],
            unknownColumns: [],
            createdCategories: [],
            createdSample: [],
            updatedSample: [],
          },
        }),
      }),
    );

    await page.goto('/products');
    await page.getByRole('button', { name: /^import$/i }).click();
    await page.getByLabel('CSV file').setInputFiles({
      name: 'bad.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Name,Stock code\r\nX,F-9\r\n'),
    });

    await expect(page.getByText(/2 rows could not be imported, so nothing was written/)).toBeVisible();
    await expect(page.getByText(/Row 4 \(F-9\)/)).toBeVisible();
    await expect(page.getByText(/is "lots", which is not a number/)).toBeVisible();
    // The offer to create them is only useful when that is the actual problem.
    await expect(page.getByText(/tick the box above/)).toBeVisible();
  });
});
