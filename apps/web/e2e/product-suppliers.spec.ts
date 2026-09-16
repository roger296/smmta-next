/**
 * The Suppliers tab on a product (Sept-2026).
 *
 * Every supplier here has `connectorKind: 'NONE'` on purpose — that is what
 * Big Bakes' 72 imported food suppliers are, and the old tab filtered exactly
 * those out, leaving an empty picker and a disabled Add button.
 */
import { expect, test } from '@playwright/test';
import { authenticatePage } from './helpers/auth';

const PRODUCT_ID = '11111111-2222-4333-8444-555555555555';
const BRAKES = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const BIDFOOD = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

const SUPPLIERS = [
  { id: BIDFOOD, name: 'Bidfood', connectorKind: 'NONE', isDropshipActive: false },
  { id: BRAKES, name: 'Brakes', connectorKind: 'NONE', isDropshipActive: false },
];

function mapping(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    productId: PRODUCT_ID,
    supplierId: BRAKES,
    supplierSku: '20954',
    costGbp: '12.50',
    supplierPurchaseUom: 'sack',
    supplierPackSize: '16.000',
    aliases: [],
    lastKnownStock: null,
    lastKnownPrice: null,
    lastPolledAt: null,
    lastPollError: null,
    isActive: true,
    priority: 1,
    ...over,
  };
}

test.describe('product suppliers tab', () => {
  test.beforeEach(async ({ page }) => {
    await authenticatePage(page);
    await page.route('**/api/v1/suppliers-dropship', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: SUPPLIERS }),
      }),
    );
    await page.route(`**/api/v1/products/${PRODUCT_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: PRODUCT_ID,
            name: 'Plain Flour',
            stockCode: 'BAKE-PLAI-FLOU',
            productType: 'PHYSICAL',
            expectedNextCost: '0.0012',
            stockUom: 'kg',
            itemKind: 'INGREDIENT',
            isSold: false,
            isStocked: true,
            requireSerialNumber: false,
            requireBatchNumber: false,
          },
        }),
      }),
    );
    for (const path of ['manufacturers', 'warehouses']) {
      await page.route(`**/api/v1/${path}*`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }),
        }),
      );
    }
    await page.route('**/api/v1/suppliers?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }),
      }),
    );
  });

  async function openTab(page: import('@playwright/test').Page) {
    await page.goto(`/products/${PRODUCT_ID}`);
    await page.getByRole('tab', { name: 'Suppliers' }).click();
  }

  // The bug this tab shipped with: no API supplier ⇒ nothing usable.
  test('offers emailed-PO suppliers, which used to be filtered out', async ({ page }) => {
    await page.route(`**/api/v1/products/${PRODUCT_ID}/supplier-mappings`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    await openTab(page);

    const add = page.getByRole('button', { name: /add a supplier/i });
    await expect(add).toBeEnabled();
    await add.click();

    const picker = page.getByLabel('Supplier');
    await expect(picker.locator('option')).toHaveText(['— pick —', 'Bidfood', 'Brakes']);
  });

  test('shows a supplier\'s code, unit and pack size', async ({ page }) => {
    await page.route(`**/api/v1/products/${PRODUCT_ID}/supplier-mappings`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [mapping()] }),
      }),
    );
    await openTab(page);

    await expect(page.getByLabel('Supplier code')).toHaveValue('20954');
    await expect(page.getByLabel('Supplier unit')).toHaveValue('sack');
    await expect(page.getByLabel('Pack size')).toHaveValue('16.000');
    await expect(page.getByLabel('Cost')).toHaveValue('12.50');
  });

  // A price you do not know must not be saved as free.
  test('an unknown cost shows blank, not 0.00, and posts as null', async ({ page }) => {
    let body: { mappings?: Array<{ costGbp: string | null }> } = {};
    await page.route(`**/api/v1/products/${PRODUCT_ID}/supplier-mappings`, (route) => {
      if (route.request().method() === 'PUT') {
        body = JSON.parse(route.request().postData() ?? '{}');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [mapping({ costGbp: null })] }),
      });
    });
    await openTab(page);

    const cost = page.getByLabel('Cost');
    await expect(cost).toHaveValue('');
    await expect(cost).toHaveAttribute('placeholder', 'not known');

    await page.getByRole('button', { name: /save suppliers/i }).click();
    await expect.poll(() => body.mappings?.[0]?.costGbp).toBeNull();
  });

  // The whole point of the (supplier, SKU) identity.
  test('the same supplier can appear twice with different codes', async ({ page }) => {
    await page.route(`**/api/v1/products/${PRODUCT_ID}/supplier-mappings`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            mapping({ id: 'm1', supplierSku: '20954', supplierPackSize: '16.000' }),
            mapping({ id: 'm2', supplierSku: 'A20954', supplierPackSize: '25.000', priority: 2 }),
          ],
        }),
      }),
    );
    await openTab(page);

    await expect(page.getByLabel('Supplier code')).toHaveCount(2);
    await expect(page.getByLabel('Supplier code').nth(0)).toHaveValue('20954');
    await expect(page.getByLabel('Supplier code').nth(1)).toHaveValue('A20954');
    await expect(page.getByLabel('Pack size').nth(1)).toHaveValue('25.000');
    await page.screenshot({ path: 'test-results/product-suppliers-tab.png' });
  });

  test('shows alternative codes and posts them back', async ({ page }) => {
    let body: { mappings?: Array<{ aliases?: string[] }> } = {};
    await page.route(`**/api/v1/products/${PRODUCT_ID}/supplier-mappings`, (route) => {
      if (route.request().method() === 'PUT') {
        body = JSON.parse(route.request().postData() ?? '{}');
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":[]}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            mapping({
              aliases: [
                { aliasSku: 'A 33891', source: 'INVOICE_OCR', lastSeenAt: null },
                { aliasSku: 'A33891', source: 'INVOICE_OCR', lastSeenAt: null },
              ],
            }),
          ],
        }),
      });
    });
    await openTab(page);

    const others = page.getByLabel('Other codes');
    await expect(others).toHaveValue('A 33891, A33891');

    await page.getByRole('button', { name: /save suppliers/i }).click();
    // The space inside "A 33891" must survive — it is part of the code.
    await expect.poll(() => body.mappings?.[0]?.aliases).toEqual(['A 33891', 'A33891']);
  });

  test('refuses the same code twice for one supplier, naming it', async ({ page }) => {
    let putCalled = false;
    await page.route(`**/api/v1/products/${PRODUCT_ID}/supplier-mappings`, (route) => {
      if (route.request().method() === 'PUT') {
        putCalled = true;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":[]}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [mapping({ id: 'm1' }), mapping({ id: 'm2' })],
        }),
      });
    });
    await openTab(page);

    await page.getByRole('button', { name: /save suppliers/i }).click();
    // .first() — the toast renders the message twice: the visible title and an
    // aria-live announcement for screen readers. Both are correct; the locator
    // just has to pick one.
    await expect(page.getByText(/"20954" is listed twice/).first()).toBeVisible();
    expect(putCalled).toBe(false);
  });
});
