/**
 * The whole 12 August session, start to finish (F15).
 *
 * Six steps, in the order the venue actually worked through them, at desktop
 * and both iPad orientations. Each individual defect has its own named test in
 * `feedback-2026-08-12.spec.ts`; this proves they compose — that a baker can
 * get from a PIN to a filed bake without falling into any of them.
 */
import { expect, test } from '@playwright/test';
import { gotoVenueScreen, signInWithPin, stubSites, TEST_VENUE } from './helpers/touch';
import { addByCode, ICING, RECEIPT, stubAug12 } from './helpers/aug12';

test.beforeEach(async ({ page }) => {
  await stubAug12(page);
});

test.describe('the 12 Aug journey, end to end', () => {
  test('1 — a PIN on a South-London-bound device lands on the venue home, naming the venue', async ({
    page,
  }) => {
    await stubSites(page);
    await signInWithPin(page, { siteId: TEST_VENUE.id, siteName: TEST_VENUE.name });
    await expect(page).toHaveURL(/\/venue/);
    await expect(page.locator('.touch-app .venue-chip').first()).toContainText('London South');
    // Not Birmingham, which is what the alphabetical default gave it (E-1).
    await expect(page.locator('.touch-app')).not.toContainText('Birmingham');
  });

  test('2 — Goods In: scan, step by packs, type a quantity, confirm the venue, book, undo, re-book', async ({
    page,
  }) => {
    const posts: Array<Record<string, unknown>> = [];
    let reversed: string | null = null;
    await page.route('**/api/v1/goods-in', (route) => {
      posts.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: RECEIPT }),
      });
    });
    await page.route('**/api/v1/goods-in/*/reverse', (route) => {
      reversed = new URL(route.request().url()).pathname.split('/').at(-2) ?? null;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { reversal: { id: 'rev-1' }, alreadyExisted: false } }),
      });
    });

    await gotoVenueScreen(page, 'goodsIn', { sites: false });

    // Scan (C-3) → the line reads in packs and kilos, not "= 1 g" (C-1).
    await addByCode(page, ICING.barcode);
    const hint = page.locator('.row', { hasText: 'Icing sugar' }).locator('.hint');
    await expect(hint).toContainText('1 × 25 kg sack = 25 kg');

    // +1 pack (C-6).
    await page.getByRole('button', { name: /add one sack of Icing sugar/i }).click();
    await expect(hint).toContainText('2 × 25 kg sack = 50 kg');

    // Type on a physical keyboard, replacing the default rather than
    // appending to it (D-4 / D-5).
    await page.getByRole('button', { name: /type received quantity/i }).click();
    await page.keyboard.type('4');
    await page.keyboard.press('Enter');
    await expect(hint).toContainText('4 × 25 kg sack = 100 kg');

    // Confirm the destination before committing (E-5).
    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await expect(page.locator('.confirm-venue-name')).toHaveText('London South');
    await page.getByRole('button', { name: /confirm and book in/i }).click();

    // A receipt that stays put (A-5), and an undo (E-3).
    await expect(page.locator('.receipt-title')).toBeVisible();
    await expect(page.locator('.undobar')).toContainText('London South');
    await page.getByRole('button', { name: /^undo$/i }).click();
    await expect.poll(() => reversed).toBe(RECEIPT.receipt.id);

    // Re-book from a clean form.
    await page.getByRole('button', { name: /book another/i }).click();
    await addByCode(page, ICING.barcode);
    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();
    await expect(page.locator('.receipt-title')).toBeVisible();
    expect(posts.length).toBe(2);
  });

  test('3 — Stock Take: open a count, read real names, count 4 kg, save, approve', async ({
    page,
  }) => {
    const counted: Array<{ productId: string; countedQty: number }> = [];
    await page.route('**/api/v1/stock-takes/*/counts', (route) => {
      const body = route.request().postDataJSON() as { counts: typeof counted };
      counted.push(...body.counts);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { recorded: body.counts.length } }),
      });
    });

    await gotoVenueScreen(page, 'stockTake', { sites: false });
    await page.getByRole('button', { name: /start count/i }).click();

    // Real names, not hex fragments (D-1).
    await expect(page.locator('.touch-app .row .name').first()).toHaveText('Icing sugar');

    // 4 kg — the count that became 0 (D-2).
    const row = page.locator('.row', { hasText: 'Icing sugar' });
    await row.getByRole('button', { name: /type quantity/i }).click();
    await page.keyboard.type('4000');
    await page.getByRole('button', { name: /^save$/i }).click();

    await page.getByRole('button', { name: /save counts/i }).click();
    await expect.poll(() => counted.length).toBeGreaterThan(0);
    const icing = counted.find((c) => c.productId === ICING.id);
    // What reached the ledger is 4000 g. Not 0, not 4100.
    expect(icing?.countedQty).toBe(4000);

    await page.getByRole('button', { name: /approve & true-up/i }).click();
    await expect(page.getByText(/approved/i).first()).toBeVisible();
  });

  test('4 — End of Bake: load the recipe, toggle modes, step by benches, see the count, submit', async ({
    page,
  }) => {
    let submitted: Record<string, unknown> | null = null;
    await page.route('**/api/v1/session-consumption', (route) => {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { id: 'c1' } }),
      });
    });

    await gotoVenueScreen(page, 'consumption', { sites: false });
    await page.getByRole('button', { name: 'Battenburg' }).click();
    await page.getByRole('button', { name: /number of regular benches/i }).click();
    await page.keyboard.type('5');
    await page.getByRole('button', { name: /^save$/i }).click();
    await page.getByLabel(/session id/i).fill('SESSION-AUG12');
    await page.getByLabel(/your name/i).fill('Test Baker');
    await page.getByRole('button', { name: /load ingredients/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();

    // Toggle to What's Left and back without losing the figure (F-2).
    const toggle = page.getByRole('button', { name: /ENTERING:/ });
    await toggle.click();
    await toggle.click();
    const used = page.getByRole('button', { name: /Type amount of Icing sugar used/i });
    await expect(used).toHaveText('2000');

    // Step by benches, and the count between the buttons tracks it (F-3).
    await page.getByRole('button', { name: /Remove one bench of Icing sugar/i }).click();
    await expect(used).toHaveText('1600');
    await expect(page.locator('.table-count').first()).toHaveText('4 / 5');

    // The bench count under the figure (F-7) — derived from the quantity, not
    // converted from anything.
    await expect(page.locator('.hint.benches').first()).toHaveText('4 of 5 benches');

    await page.getByRole('button', { name: /submit consumption/i }).click();
    await expect.poll(() => submitted).not.toBeNull();
    const body = submitted as unknown as { lines: Array<Record<string, unknown>>; covers: number };
    expect(body.covers).toBe(5);
    expect(body.lines[0]!.entryMode).toBe('CONSUMED');
  });

  test('5 — Offline: work is held, the pill says so, and it replays by itself', async ({ page }) => {
    let posted = 0;
    await page.route('**/api/v1/goods-in', (route) => {
      posted += 1;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: RECEIPT }),
      });
    });

    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);

    await page.context().setOffline(true);
    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();
    await expect(page.locator('.syncpill')).toContainText(/Offline|Pending/, { timeout: 15_000 });

    // The drawer answers "did my work go in?" (A-4).
    await page.locator('.syncpill').click();
    await expect(page.getByText('Work waiting to sync')).toBeVisible();
    await page.getByRole('button', { name: /close/i }).first().click();

    await page.context().setOffline(false);
    // Replayed with nobody navigating anywhere (A-2), and the pill settles.
    await expect.poll(() => posted, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.locator('.syncpill')).toContainText('All saved', { timeout: 20_000 });
  });

  test('6 — Rejection: the banner says so, nothing is queued, and the entries survive', async ({
    page,
  }) => {
    await page.route('**/api/v1/goods-in', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Site London South has no open receiving bay' }),
      }),
    );

    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();

    // A rejection is not a queue (A-1) — the whole point of the defect.
    await expect(page.locator('.notice-error')).toContainText('receiving bay');
    await expect(page.getByText('Icing sugar')).toBeVisible();
    await expect(page.locator('.syncpill')).toContainText('All saved');
  });
});
