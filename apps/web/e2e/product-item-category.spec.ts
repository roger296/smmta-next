import { expect, test } from '@playwright/test';
import { authenticatePage } from './helpers/auth';

// Real uuids: the form validates the id, so 'c1' would render "Invalid uuid"
// and the fixture would be testing something production never does.
const DRY_STOCK_ID = '11111111-2222-4333-8444-555555555555';
const CATEGORIES = [
  { id: DRY_STOCK_ID, name: 'Dry Stock', sortOrder: 0, productCount: 12 },
  { id: '66666666-7777-4888-8999-aaaaaaaaaaaa', name: 'Bar', sortOrder: 0, productCount: 3 },
];

test.describe('item category + stock check instruction', () => {
  test.beforeEach(async ({ page }) => {
    await authenticatePage(page);
    await page.route('**/api/v1/item-categories', async (route) => {
      if (route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() ?? '{}') as { name: string };
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
              name: body.name,
              sortOrder: 0,
              productCount: 0,
              created: true,
            },
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CATEGORIES }),
      });
    });
    // NB the shapes differ: the reference lists are plain arrays, suppliers is
    // paginated. Returning the wrong one crashes the form on `.map`.
    for (const path of ['manufacturers', 'warehouses']) {
      await page.route(`**/api/v1/${path}*`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }),
        }),
      );
    }
    await page.route('**/api/v1/suppliers*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }),
      }),
    );
  });

  test('offers the existing categories and a 200-char instruction box', async ({ page }) => {
    await page.goto('/products/new');
    await expect(page.getByLabel('Name')).toBeVisible();

    const instruction = page.getByLabel('Stock check instruction');
    await expect(instruction).toBeVisible();
    await expect(instruction).toHaveAttribute('maxlength', '200');
    await instruction.fill('Weigh, do not count');

    await page.getByRole('combobox', { name: 'Item category' }).click();
    await expect(page.getByRole('option', { name: 'Dry Stock' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Bar' })).toBeVisible();
    await page.getByRole('option', { name: 'Dry Stock' }).click();

    // The choice sticks, and the form is not complaining about it.
    await expect(page.getByRole('combobox', { name: 'Item category' })).toContainText('Dry Stock');
    await expect(page.getByText('Invalid uuid')).toBeHidden();
    await page.screenshot({ path: 'test-results/product-item-category.png' });
  });

  // The whole point of the field: the list is extensible from where you are.
  test('adds a category without leaving the product form', async ({ page }) => {
    await page.goto('/products/new');
    await page.getByRole('combobox', { name: 'Item category' }).click();
    await page.getByRole('option', { name: /Add a new category/ }).click();

    const input = page.getByLabel('New item category name');
    await expect(input).toBeVisible();
    await input.fill('Cleaning');
    await page.getByRole('button', { name: /^add$/i }).click();

    // Back to the select, with the new category chosen and the form intact.
    await expect(page.getByLabel('New item category name')).toBeHidden();
    await expect(page.getByLabel('Name')).toBeVisible();
  });

  test('Enter in the new-category box does not submit the product form', async ({ page }) => {
    let productPosted = false;
    await page.route('**/api/v1/products', (route) => {
      if (route.request().method() === 'POST') productPosted = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{}}' });
    });

    await page.goto('/products/new');
    await page.getByRole('combobox', { name: 'Item category' }).click();
    await page.getByRole('option', { name: /Add a new category/ }).click();
    await page.getByLabel('New item category name').fill('Cleaning');
    await page.getByLabel('New item category name').press('Enter');

    await expect(page.getByLabel('New item category name')).toBeHidden();
    expect(productPosted).toBe(false);
  });
});
