/**
 * iPad layout repro harness — Aug-2026 feedback set, F1.
 *
 * These specs reproduce the layout defects the 12 Aug venue test hit. F1 added
 * them as `test.fixme()` — they failed against the pre-F5 tree, which was the
 * point. **F5 fixed the layout and unfixmed them**; they are live regressions
 * now.
 *
 *   B-1  "Screen formatting cuts off the top of the page rendering any initial
 *         line inputs invisible and uneditable"
 *   B-2  the keyboard opens on load (autoFocus on the goods-in barcode input)
 *   B-5  the venue name is missing from several screens
 */
import { expect, test } from '@playwright/test';
import {
  expectFirstBodyControlHittable,
  expectNoInputFocusedOnMount,
  expectTopbarVisible,
  focusFirstInput,
  gotoVenueScreen,
  TEST_VENUE,
  VENUE_SCREENS,
} from './helpers/touch';

const SCREENS = Object.keys(VENUE_SCREENS) as Array<keyof typeof VENUE_SCREENS>;

for (const screen of SCREENS) {
  test(`B-1 ${screen}: the top of the screen stays reachable after focusing an input`, async ({ page }) => {
    await gotoVenueScreen(page, screen);
    await expectTopbarVisible(page);
    await expectFirstBodyControlHittable(page);

    await focusFirstInput(page);

    await expectTopbarVisible(page);
    await expectFirstBodyControlHittable(page);
  });

  test(`B-4 ${screen}: renders on its own, not over the desktop admin chrome`, async ({ page }) => {
    await gotoVenueScreen(page, screen);
    // The venue screens are their own layout route now. Nothing from the
    // desktop shell — sidebar, header, or the padded <main> — is behind them.
    await expect(page.getByRole('complementary', { name: /main navigation/i })).toHaveCount(0);
    await expect(page.locator('header')).toHaveCount(0);
    await expect(page.locator('main.p-6')).toHaveCount(0);
    // And the document itself does not scroll under the overlay (B-3).
    const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(bodyOverflow).toBe('hidden');
  });

  test(`B-5 ${screen}: shows the venue NAME, not a placeholder`, async ({ page }) => {
    await gotoVenueScreen(page, screen);
    const chip = page.locator('.touch-app .venue-chip').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(new RegExp(TEST_VENUE.name));
  });
}

/**
 * The mechanism test for B-1.
 *
 * Chromium has no soft keyboard, so simply focusing an input at iPad metrics
 * does NOT shrink the visual viewport — which means the plain B-1 specs above
 * pass on the broken tree too. They guard the layout; this one guards the
 * actual fix. It installs a stub `window.visualViewport` reporting a shrunken,
 * offset viewport (exactly what iOS does when the keyboard opens), fires the
 * resize, and asserts the shell tracks it instead of being scrolled off the
 * top of the glass.
 */
test('B-1 MECHANISM: the shell tracks a shrinking visual viewport', async ({ page }) => {
  await page.addInitScript(() => {
    const listeners: Record<string, Array<() => void>> = { resize: [], scroll: [] };
    const stub = {
      height: window.innerHeight,
      width: window.innerWidth,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener: (type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
      },
      dispatchEvent: () => true,
    };
    Object.defineProperty(window, 'visualViewport', { value: stub, configurable: true });
    // The handle the test reaches for to "open the keyboard".
    (window as unknown as { __openKeyboard: (h: number, top: number) => void }).__openKeyboard = (
      h: number,
      top: number,
    ) => {
      stub.height = h;
      stub.offsetTop = top;
      for (const fn of listeners.resize ?? []) fn();
      for (const fn of listeners.scroll ?? []) fn();
    };
  });

  await gotoVenueScreen(page, 'goodsIn');
  await expectTopbarVisible(page);

  const keyboardHeight = 320;
  const scrolledBy = 180;
  await page.evaluate(
    ([h, top]) =>
      (window as unknown as { __openKeyboard: (h: number, top: number) => void }).__openKeyboard(
        h as number,
        top as number,
      ),
    [Math.max(200, (page.viewportSize()?.height ?? 800) - keyboardHeight), scrolledBy],
  );

  // The shell is now sized to the visible glass and offset to sit on it.
  const shell = page.locator('.touch-app');
  const height = await shell.evaluate((el) => getComputedStyle(el).height);
  expect(parseFloat(height)).toBeLessThan((page.viewportSize()?.height ?? 800) - keyboardHeight + 5);

  const transform = await shell.evaluate((el) => getComputedStyle(el).transform);
  expect(transform, 'the shell does not follow the visual viewport').not.toBe('none');

  // And the topbar is still on screen, which is the whole point.
  await expectTopbarVisible(page);
});

test('B-2 goods-in does not open the keyboard on load', async ({ page }) => {
  await gotoVenueScreen(page, 'goodsIn');
  await expectNoInputFocusedOnMount(page);
});

test('B-5 pin-login names the device\'s venue', async ({ page }) => {
  // A device that has been signed into before knows its venue; one that never
  // has says so rather than staying silent about it.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'autostock_device_site',
      JSON.stringify({ siteId: 'site-1', siteName: 'London South' }),
    );
  });
  await page.goto('/pin-login');
  await expect(page.locator('.touch-app .venue-chip')).toHaveText(/London South/);
});

test('B-5 pin-login says so when the device has no venue bound', async ({ page }) => {
  await page.goto('/pin-login');
  await expect(page.locator('.touch-app .venue-chip')).toHaveText(/not set for this device/i);
});
