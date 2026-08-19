/**
 * Book, confirm, undo, on a venue iPad (Aug-2026 feedback set, E-1/E-3/E-5).
 *
 * "Accidental booking logged 100kg to Birmingham; requested an undo timer or
 * role-based permission locks."
 */
import { expect, test } from '@playwright/test';
import { gotoVenueScreen, stubSites, TEST_VENUE } from './helpers/touch';

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

const RECEIPT = {
  receipt: {
    id: 'receipt-1',
    siteId: TEST_VENUE.id,
    reference: null,
    totalStockValue: '120.00',
    receivedAt: '2026-08-19T10:00:00.000Z',
  },
  lines: [],
  alreadyExisted: false,
};

test.describe('goods-in: confirm the venue, then undo', () => {
  test('E-5/E-3: the sheet names the venue, and the undo bar reverses it', async ({ page }) => {
    await page.route('**/api/v1/products**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [ICING], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
      }),
    );
    await page.route('**/api/v1/goods-in', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: RECEIPT }),
      }),
    );

    let reversedId: string | null = null;
    await page.route('**/api/v1/goods-in/*/reverse', (route) => {
      reversedId = new URL(route.request().url()).pathname.split('/').at(-2) ?? null;
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { reversal: { id: 'rev-1' } } }),
      });
    });

    await gotoVenueScreen(page, 'goodsIn');

    await page.getByLabel(/product code/i).fill('5012345678900');
    await page.getByRole('button', { name: /\+ add/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();

    // Bump to 4 packs.
    for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: /^increase$/i }).click();

    await page.getByRole('button', { name: /book in 1 line/i }).click();

    // E-5: the confirmation restates the destination, large.
    await expect(page.getByText('Book this delivery in?')).toBeVisible();
    await expect(page.locator('.confirm-venue-name')).toHaveText(TEST_VENUE.name);
    await expect(page.locator('.confirm-line-qty')).toHaveText('4 × 25 kg sack = 100000 g');

    await page.getByRole('button', { name: /confirm and book in/i }).click();

    // E-3: the undo bar names where it went.
    const undoBar = page.locator('.undobar');
    await expect(undoBar).toBeVisible();
    await expect(undoBar).toContainText(`Booked to ${TEST_VENUE.name}`);

    await page.getByRole('button', { name: /^undo$/i }).click();
    await expect.poll(() => reversedId).toBe('receipt-1');
    await expect(undoBar).toHaveCount(0);
  });

  test('E-5: cancelling the confirmation books nothing and keeps the lines', async ({ page }) => {
    let posted = false;
    await page.route('**/api/v1/products**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [ICING], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
      }),
    );
    await page.route('**/api/v1/goods-in', (route) => {
      posted = true;
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, data: RECEIPT }) });
    });

    await gotoVenueScreen(page, 'goodsIn');
    await page.getByLabel(/product code/i).fill('5012345678900');
    await page.getByRole('button', { name: /\+ add/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();

    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /^cancel$/i }).click();

    expect(posted).toBe(false);
    await expect(page.getByText('Icing sugar')).toBeVisible();
  });
});

test.describe('E-1: the venue chip tells the truth about the binding', () => {
  test('a device with no binding shows the warn state', async ({ page }) => {
    // No device-site entry, so the provider falls through to the first active
    // site — the 12 Aug behaviour, now labelled rather than silent.
    await stubSites(page, [
      { id: 'site-birmingham', slug: 'birmingham', name: 'Birmingham', isActive: true },
      { ...TEST_VENUE, isActive: true },
    ]);
    await gotoVenueScreen(page, 'goodsIn');

    const chip = page.locator('.touch-app .venue-chip').first();
    await expect(chip).toHaveClass(/warn/);
    await expect(chip).toContainText(/not set for this device/i);
  });

  test('E-1: a device bound to London South does NOT show Birmingham', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'autostock_device_site',
        JSON.stringify({ siteId: 'site-1', siteName: 'London South' }),
      );
    });
    await stubSites(page, [
      { id: 'site-birmingham', slug: 'birmingham', name: 'Birmingham', isActive: true },
      { ...TEST_VENUE, isActive: true },
    ]);
    await gotoVenueScreen(page, 'goodsIn');

    const chip = page.locator('.touch-app .venue-chip').first();
    await expect(chip).toHaveText(TEST_VENUE.name);
    await expect(chip).not.toHaveClass(/warn/);
  });
});
