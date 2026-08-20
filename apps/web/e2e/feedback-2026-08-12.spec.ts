/**
 * The 12 August 2026 defect register, one named test per ID (F15).
 *
 * Every title quotes the tester. The point is not coverage — most of these
 * have a dedicated spec elsewhere — but a single readable list somebody can
 * run before the next venue session and see that each reported symptom still
 * has a test with its name on it. A defect with no automated check is an
 * explicit `test.skip` carrying the reason; there are no silent gaps.
 *
 * Runs at desktop and both iPad orientations, because half the register only
 * reproduced on the iPad.
 */
import { expect, test } from '@playwright/test';
import { authenticatePage } from './helpers/auth';
import { gotoVenueScreen, stubSites } from './helpers/touch';
import { addByCode, ICING, SKITTLES, stubAug12 } from './helpers/aug12';

test.beforeEach(async ({ page }) => {
  await stubAug12(page);
});

// ── A — saved work, sync and feedback ────────────────────────────────
test.describe('A — saved work, sync and feedback', () => {
  test('A-1: submissions reported as "Saved offline — will sync" even when the server rejected them', async ({
    page,
  }) => {
    await page.route('**/api/v1/goods-in', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Site has no open receiving bay' }),
      }),
    );
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    await expect(page.getByText('Icing sugar')).toBeVisible();

    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();

    // A rejection, not a queue. The banner says so and the line survives.
    await expect(page.locator('.notice-error')).toContainText(/refused|not booked/i);
    await expect(page.getByText('Icing sugar')).toBeVisible();
    // …and nothing was queued: the pill is not showing pending work.
    await expect(page.locator('.syncpill')).not.toContainText(/Pending/);
  });

  test('A-2: queued work never reached the server', async ({ page }) => {
    // The mechanism, asserted where it lives: the replayer is mounted at the
    // app root, so a device that regains connectivity anywhere replays.
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await expect(page.locator('.syncpill')).toBeVisible();

    let posted = 0;
    await page.route('**/api/v1/goods-in', (route) => {
      posted += 1;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { receipt: { id: 'r1', siteId: 'site-1', reference: null, totalStockValue: '30.00', receivedAt: '2026-08-19T10:00:00Z' }, lines: [], alreadyExisted: false },
        }),
      });
    });

    await addByCode(page, ICING.barcode);
    await page.context().setOffline(true);
    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();
    await expect(page.locator('.syncpill')).toContainText(/Offline|Pending/);

    await page.context().setOffline(false);
    // Replayed without anybody navigating anywhere.
    await expect.poll(() => posted, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.locator('.syncpill')).toContainText('All saved', { timeout: 15_000 });
  });

  test('A-3: the sync pill never showed pending work', async ({ page }) => {
    // A transport failure, aborted rather than emulated offline: the pill's
    // claim under test is the *depth*, and an abort makes that deterministic.
    await page.route('**/api/v1/goods-in', (route) => route.abort('failed'));

    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();

    // A real depth, not a mutation's isPending — which is what made the
    // pill's `pending` and `offline` branches dead code.
    await expect(page.locator('.syncpill')).toContainText(/1 waiting|Pending 1/, {
      timeout: 15_000,
    });
  });

  test('A-4: no way to answer "did my count actually go in?"', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await page.locator('.syncpill').click();
    // The drawer lists what is unsent, so the venue can answer it themselves.
    await expect(page.getByText('Work waiting to sync')).toBeVisible();
    await expect(page.getByText(/Waiting to send/)).toBeVisible();
  });

  test('A-5: "Lack of visual feedback on screen exits leaves users uncertain whether inputs are saved, deleted, or processed"', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();

    // A receipt that stays on screen, not a toast and an empty list.
    await expect(page.locator('.receipt-title')).toBeVisible();
    await expect(page.getByRole('button', { name: /book another/i })).toBeVisible();
  });

  test('A-6: a failed barcode lookup silently did nothing', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, '0000000000000');
    // Says so, and offers the name search — rather than nothing at all.
    // A sheet that names the code and offers a way forward — search by name,
    // or attach the code to the product so the next delivery scans first time.
    await expect(page.getByText('Nothing found for "0000000000000"')).toBeVisible();
    await expect(page.locator('.touch-app')).toContainText(/search for the product by name/i);
  });
});

// ── B — layout, chrome and legibility ────────────────────────────────
test.describe('B — layout, chrome and legibility', () => {
  test('B-1: "Screen formatting cuts off the top of the page rendering any initial line inputs invisible and uneditable"', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    const topbar = await page.locator('.touch-app .topbar').boundingBox();
    expect(topbar).not.toBeNull();
    // Fully inside the glass, not merely present in the DOM.
    expect(topbar!.y).toBeGreaterThanOrEqual(0);
    await page.getByLabel(/product code/i).focus();
    const after = await page.locator('.touch-app .topbar').boundingBox();
    expect(after!.y).toBeGreaterThanOrEqual(0);
  });

  test('B-2: keyboard opened on load and pushed the page up', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(focused).not.toBe('INPUT');
  });

  test('B-3: background page scrolled underneath the venue screens', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    const overflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(overflow).toBe('hidden');
  });

  test('B-4: venue screens were drawn over an admin page nobody could see', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await expect(page.getByRole('complementary', { name: /main navigation/i })).toHaveCount(0);
  });

  test('B-5: venue name missing from several screens', async ({ page }) => {
    for (const screen of ['goodsIn', 'stockTake', 'consumption'] as const) {
      await gotoVenueScreen(page, screen, { sites: false });
      await expect(page.locator('.touch-app .venue-chip').first()).toContainText('London South');
    }
  });

  test('B-6: desktop venue-name selector unreadable', async ({ page }) => {
    await authenticatePage(page);
    await stubSites(page);
    await page.goto('/');

    const trigger = page.getByRole('combobox', { name: /active site/i });
    await expect(trigger).toBeVisible();
    const { colour, background } = await trigger.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      return { colour: cs.color, background: cs.backgroundColor };
    });
    // The defect was pale-grey-on-near-white, about 1.6:1, on the one control
    // that says where stock is being booked. The numeric ratio is asserted in
    // site-switcher-contrast.test.ts; here it is enough that the foreground is
    // not the shell's pale grey and not the background itself.
    expect(colour).not.toBe(background);
    await expect(trigger).toContainText('London South');
  });

  test('B-7: "Page transitions feel quite abrupt; retaining a collapsible side menu might improve navigation confidence and confirm the active page"', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    const rail = page.locator('.venue-rail');
    if (await rail.isVisible().catch(() => false)) {
      await expect(rail.getByRole('button', { name: /Goods In/ })).toHaveAttribute('aria-current', 'page');
    } else {
      await page.getByRole('button', { name: /open menu/i }).click();
      await expect(
        page.locator('.venue-drawer').getByRole('button', { name: /Goods In/ }),
      ).toHaveAttribute('aria-current', 'page');
    }
  });
});

// ── C — products, units and cost ─────────────────────────────────────
test.describe('C — products, units and cost', () => {
  test('C-1: "Icing sugar displayed an incorrect default unit quantity of 1kg"', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    const hint = page.locator('.row', { hasText: 'Icing sugar' }).locator('.hint');
    await expect(hint).toContainText('1 × 25 kg sack = 25 kg');
    await expect(hint).not.toContainText('= 1 g');
  });

  test('C-2: "Skittles displayed an incorrect base unit, preventing the 1.6kg bags from being added"', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, SKITTLES.barcode);
    await expect(page.locator('.row', { hasText: 'Skittles' }).locator('.hint')).toContainText(
      '1 × 1.6 kg bag = 1.6 kg',
    );
  });

  test('C-3: "Manual barcode entry failed to find the product for an icing sugar delivery"', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    await expect(page.getByText('Icing sugar')).toBeVisible();
  });

  test('C-4: costs displayed as £0.00', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    const hint = page.locator('.row', { hasText: 'Icing sugar' }).locator('.hint');
    await expect(hint).toContainText('£30.00/sack');
    // £30 over 25 000 g is £0.0012 — which 2dp formatting showed as £0.00.
    await expect(hint).toContainText('£0.0012/g');
  });

  test('C-5: could not set a price from the venue screen', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    // The control exists on the line; whether this operator may use it is the
    // role guard's business (E-4) and is asserted server-side.
    await expect(page.getByRole('button', { name: /cost & batch details/i }).first()).toBeVisible();
    await page.getByRole('button', { name: /cost & batch details/i }).first().click();
    await expect(page.getByLabel(/unit cost/i)).toBeVisible();
  });

  test('C-6: "Request to add base-unit increment buttons (e.g. auto-filling to 25kg and adding +25kg per click)"', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    const addSack = page.getByRole('button', { name: /add one sack of Icing sugar/i });
    await expect(addSack).toHaveText('+1 sack');
    await addSack.click();
    await expect(page.locator('.row', { hasText: 'Icing sugar' }).locator('.hint')).toContainText(
      '2 × 25 kg sack = 50 kg',
    );
  });
});

// ── D — counting and number entry ────────────────────────────────────
test.describe('D — counting and number entry', () => {
  test('D-1: "Every row read as a raw alphanumeric string, so no count could be logged"', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'stockTake', { sites: false });
    await page.getByRole('button', { name: /start count/i }).click();
    const first = page.locator('.touch-app .row .name').first();
    await expect(first).toHaveText('Icing sugar');
    await expect(first).not.toHaveText(/^[0-9a-f]{8}$/);
  });

  test('D-1b: the count sheet carries product identity with it', async ({ page }) => {
    // The supplementary lookup is broken on purpose: a legible sheet must not
    // depend on a second, larger, fallible request.
    await page.route('**/api/v1/products?**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' }),
    );
    await gotoVenueScreen(page, 'stockTake', { sites: false });
    await page.getByRole('button', { name: /start count/i }).click();
    await expect(page.locator('.touch-app .row .name').first()).toHaveText('Icing sugar');
  });

  test('D-2: counts silently rounded to the nearest 100 stock units (4 kg → 0)', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake', { sites: false });
    await page.getByRole('button', { name: /start count/i }).click();

    const row = page.locator('.row', { hasText: 'Icing sugar' });
    await row.getByRole('button', { name: /type quantity/i }).click();
    await page.keyboard.type('4000');
    await page.getByRole('button', { name: /^save$/i }).click();

    // 4 kg stays 4 kg. The blanket quantum turned it into nothing.
    await expect(row.getByRole('button', { name: /type quantity/i })).toHaveText('4000');
  });

  test('D-3: search on the count screen did not find items', async ({ page }) => {
    await gotoVenueScreen(page, 'stockTake', { sites: false });
    await page.getByRole('button', { name: /start count/i }).click();
    await page.getByPlaceholder(/search items/i).fill('ING-SKITTLE');
    await expect(page.getByText('Skittles')).toBeVisible();
    await expect(page.getByText('Icing sugar')).toHaveCount(0);
  });

  test('D-4: "Default numbers are not overridden when typing (entering \'3\' into a default field of \'1\' results in \'13\')"', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    await page.getByRole('button', { name: /type received quantity/i }).first().click();
    await page.keyboard.type('3');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.locator('.row', { hasText: 'Icing sugar' }).locator('.hint')).toContainText(
      '3 × 25 kg sack',
    );
  });

  test('D-5: "Request to enable direct number pad typing on laptop keyboards"', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    await page.getByRole('button', { name: /type received quantity/i }).first().click();
    await page.keyboard.type('12');
    await page.keyboard.press('Enter');
    await expect(page.locator('.row', { hasText: 'Icing sugar' }).locator('.hint')).toContainText(
      '12 × 25 kg sack',
    );
  });
});

// ── E — site binding, PWA entry and permissions ──────────────────────
test.describe('E — site binding, PWA entry and permissions', () => {
  test('E-1: "Accidental booking logged 100kg to Birmingham" from a South London device', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    const chip = page.locator('.touch-app .venue-chip').first();
    await expect(chip).toContainText('London South');
    await expect(chip).not.toContainText('Birmingham');
  });

  test('E-2: "Adding the iPad PIN login page to the home screen redirects incorrectly to the standard email login page"', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // What an installed home-screen icon looks like to the app.
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (q: string) => ({
          matches: q.includes('display-mode: standalone'),
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          onchange: null,
          dispatchEvent: () => false,
        }),
      });
    });
    await page.goto('/');
    await expect(page).toHaveURL(/\/pin-login/);
  });

  test('E-3: "Requested an undo timer"', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await page.getByRole('button', { name: /confirm and book in/i }).click();
    await expect(page.locator('.undobar')).toBeVisible();
    await expect(page.locator('.undobar')).toContainText('London South');
  });

  test('E-4: "…or role-based permission locks"', async ({ page }) => {
    // The lock itself is server-side (asserted in the API register). Here:
    // the UI reflects it rather than offering a button that 403s.
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await expect(page.locator('.touch-app')).toBeVisible();
    test.skip(
      true,
      'role reflection needs a PIN token carrying head_baker; the enforcement itself is asserted in apps/api/src/modules/feedback-2026-08-12.test.ts (E-4) and the UI reflection in pwa-roles component tests',
    );
  });

  test('E-5: no confirmation of the destination venue before booking', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn', { sites: false });
    await addByCode(page, ICING.barcode);
    await page.getByRole('button', { name: /book in 1 line/i }).click();
    await expect(page.getByText('Book this delivery in?')).toBeVisible();
    await expect(page.locator('.confirm-venue-name')).toHaveText('London South');
  });

  test('E-6: manifest locked to portrait', async ({ page }) => {
    const res = await page.request.get('/manifest.webmanifest');
    expect(res.ok()).toBeTruthy();
    const manifest = (await res.json()) as { orientation?: string; start_url?: string };
    expect(manifest.orientation).not.toBe('portrait');
    // …and the installed icon opens the PIN screen (E-2's other half).
    expect(manifest.start_url).toContain('/pin-login');
  });
});

// ── F — End of Bake and recipe data ──────────────────────────────────
test.describe('F — End of Bake and recipe data', () => {
  async function loadBake(page: import('@playwright/test').Page, tables = 5) {
    await gotoVenueScreen(page, 'consumption', { sites: false });
    await page.getByRole('button', { name: 'Battenburg' }).click();
    await page.getByRole('button', { name: /number of regular benches/i }).click();
    await page.keyboard.type(String(tables));
    await page.getByRole('button', { name: /^save$/i }).click();
    await page.getByLabel(/session id/i).fill('SESSION-AUG12');
    await page.getByLabel(/your name/i).fill('Test Baker');
    await page.getByRole('button', { name: /load ingredients/i }).click();
    await expect(page.getByText('Icing sugar')).toBeVisible();
  }

  test('F-1: "\'Table +\' and \'Table -\' buttons are reversed when switching to \'What\'s Left\' mode"', async ({
    page,
  }) => {
    await loadBake(page);
    await page.getByRole('button', { name: /ENTERING: AMOUNT USED/ }).click();
    const value = page.getByRole('button', { name: /Type what is left of Icing sugar/i });
    await page.getByRole('button', { name: /Add one bench left of Icing sugar/i }).click();
    // "+1 table left" INCREASES what is left. On 12 Aug it decreased it, while
    // the plain + beside it increased — two controls, opposite directions.
    await expect(value).toHaveText('400');
  });

  test('F-2: "Toggling to \'What\'s Left\' resets the counter to 0, but toggling back does not reset it back"', async ({
    page,
  }) => {
    await loadBake(page);
    const toggle = page.getByRole('button', { name: /ENTERING:/ });
    await toggle.click();
    await toggle.click();
    await expect(page.getByRole('button', { name: /Type amount of Icing sugar used/i })).toHaveText('2000');
  });

  test('F-3: show the live table count implied by the current quantity', async ({ page }) => {
    await loadBake(page);
    await expect(page.locator('.table-count').first()).toHaveText('5 / 5');
    await page.getByRole('button', { name: /Remove one bench of Icing sugar/i }).click();
    await expect(page.locator('.table-count').first()).toHaveText('4 / 5');
  });

  test('F-4: "Displayed recipes are not part of our offering of course"', async ({ page }) => {
    await gotoVenueScreen(page, 'consumption', { sites: false });
    // The cake list is whatever was imported — no invented demo menu shipped
    // with the app. (The seed that produced them now refuses to run; asserted
    // in apps/api/scripts/demo/seed-bakes.demo.test.ts.)
    await expect(page.getByRole('button', { name: 'Battenburg' })).toBeVisible();
    for (const invented of ['Burger Cake', 'Coffee & Walnut Delight']) {
      await expect(page.getByRole('button', { name: invented })).toHaveCount(0);
    }
  });

  test('F-5: "Selecting Vegan or GF options for Battenburg failed to generate required ingredients"', async ({
    page,
  }) => {
    await page.route('**/api/v1/recipes/coverage**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { hasRecipe: true, glutenFree: false, vegan: true } }),
      }),
    );
    await gotoVenueScreen(page, 'consumption', { sites: false });
    await page.getByRole('button', { name: 'Battenburg' }).click();
    // A diet with no recipe is refused up front rather than accepting a number
    // that silently produces the standard ingredient list.
    await expect(page.getByText(/no gluten-free recipe for this cake/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /number of gluten free benches/i })).toBeDisabled();
  });

  test('F-6: "No bake logs were submitted due to incorrect recipe data"', async ({ page }) => {
    await page.route('**/api/v1/recipes/expected', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            lines: [],
            blockers: [{ kind: 'NO_RECIPE', message: 'No recipe for "Battenburg" on 2026-08-12 at this site.' }],
          },
        }),
      }),
    );
    await gotoVenueScreen(page, 'consumption', { sites: false });
    await page.getByRole('button', { name: 'Battenburg' }).click();
    await page.getByRole('button', { name: /number of regular benches/i }).click();
    await page.keyboard.type('5');
    await page.getByRole('button', { name: /^save$/i }).click();
    await page.getByRole('button', { name: /load ingredients/i }).click();

    const notice = page.getByRole('alert');
    await expect(notice).toContainText('This bake cannot be recorded');
    await expect(notice).toContainText('This bake cannot be submitted.');
    // …and it never advanced into an empty ingredient list.
    await expect(page.getByRole('button', { name: /submit consumption/i })).toHaveCount(0);
  });

  test('F-7: "Request to show benches under the kilo figures"', async ({ page }) => {
    await loadBake(page);
    // The count under the figure, in the venue's word. No site setting, and
    // crucially no "≈ N benches" multiplied out of a per-site ratio — a bench
    // and a table are the same thing.
    await expect(page.locator('.hint.benches').first()).toHaveText('5 of 5 benches');
    await expect(page.locator('.hint.benches').first()).not.toContainText('≈');
  });

  test('F-8: client/server type drift on consumption lines', async ({ page }) => {
    let body: Record<string, unknown> | null = null;
    await page.route('**/api/v1/session-consumption', (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { id: 'c1' } }),
      });
    });
    await loadBake(page);
    await page.getByRole('button', { name: /ENTERING: AMOUNT USED/ }).click();
    await page.getByRole('button', { name: /Type what is left of Icing sugar/i }).click();
    await page.keyboard.type('250');
    await page.getByRole('button', { name: /^save$/i }).click();
    await page.getByRole('button', { name: /submit consumption/i }).click();

    await expect.poll(() => body).not.toBeNull();
    const lines = (body as unknown as { lines: Array<Record<string, unknown>> }).lines;
    // The two fields the server validates and the client type used to omit.
    expect(lines[0]!.entryMode).toBe('REMAINING');
    expect(lines[0]!.remainingQty).toBe(250);
  });
});
