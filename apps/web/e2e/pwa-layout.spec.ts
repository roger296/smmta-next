/**
 * iPad layout repro harness — Aug-2026 feedback set, F1.
 *
 * These specs reproduce the layout defects the 12 Aug venue test hit. They are
 * `test.fixme()` deliberately: they FAIL against the pre-F5 tree, and that is
 * the point — F1 builds the harness, F5 fixes the layout and unfixmes them.
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
  VENUE_SCREENS,
} from './helpers/touch';

const SCREENS = Object.keys(VENUE_SCREENS) as Array<keyof typeof VENUE_SCREENS>;

for (const screen of SCREENS) {
  test.fixme(`B-1 ${screen}: the top of the screen stays reachable after focusing an input`, async ({ page }) => {
    await gotoVenueScreen(page, screen);
    await expectTopbarVisible(page);
    await expectFirstBodyControlHittable(page);

    await focusFirstInput(page);

    await expectTopbarVisible(page);
    await expectFirstBodyControlHittable(page);
  });

  test.fixme(`B-4 ${screen}: renders on its own, not over the desktop admin chrome`, async ({ page }) => {
    await gotoVenueScreen(page, screen);
    await expect(page.getByRole('navigation', { name: /main navigation/i })).toHaveCount(0);
  });

  test.fixme(`B-5 ${screen}: shows the venue name`, async ({ page }) => {
    await gotoVenueScreen(page, screen);
    await expect(page.locator('.touch-app .venue-chip')).toBeVisible();
  });
}

test.fixme('B-2 goods-in does not open the keyboard on load', async ({ page }) => {
  await gotoVenueScreen(page, 'goodsIn');
  await expectNoInputFocusedOnMount(page);
});
