/**
 * Navigation confidence (Aug-2026 feedback set, B-7).
 *
 * "Page transitions feel quite abrupt; retaining a collapsible side menu might
 *  improve navigation confidence and confirm the active page."
 *
 * The venue half runs at both iPad orientations: the landscape rail and the
 * portrait drawer are different components answering the same need, and only
 * one of them is on screen at a time.
 */
import { expect, test } from '@playwright/test';
import { authenticatePage } from './helpers/auth';
import { gotoVenueScreen } from './helpers/touch';

/** The floor for anything a person taps in a kitchen. */
const MIN_TARGET = 46;

async function boxOf(locator: import('@playwright/test').Locator) {
  const box = await locator.boundingBox();
  expect(box, 'element has no box — it is not on screen').not.toBeNull();
  return box!;
}

/**
 * Which of the two navigations is expected here. Landscape iPads and desktop
 * have the width for a persistent rail; a portrait iPad does not, and gets the
 * labelled Menu button instead. Asserted explicitly rather than sniffed, so a
 * regression that quietly drops the rail to a drawer everywhere still fails.
 */
function expectsRail(viewport: { width: number } | null): boolean {
  return (viewport?.width ?? 0) >= 900;
}

test.describe('venue navigation', () => {
  test('B-7: landscape gets the persistent rail, portrait gets the Menu button', async ({
    page,
  }) => {
    await gotoVenueScreen(page, 'goodsIn');
    const rail = page.locator('.venue-rail');
    const menu = page.getByRole('button', { name: /open menu/i });

    if (expectsRail(page.viewportSize())) {
      await expect(rail).toBeVisible();
      await expect(menu).toHaveCount(0);
      // The rail must not sit on top of the screen it navigates: `.touch-app`
      // is a fixed overlay, so the layout indents it rather than flexing.
      const railBox = await boxOf(rail);
      const appBox = await boxOf(page.locator('.touch-app'));
      expect(appBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width - 1);
    } else {
      await expect(rail).toHaveCount(0);
      await expect(menu).toBeVisible();
    }
  });

  test('B-7: the current job is marked, in words as well as colour', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn');

    const rail = page.getByRole('navigation', { name: /venue navigation/i });
    if (await rail.isVisible().catch(() => false)) {
      // Landscape: the rail is already there.
      await expect(rail.getByRole('button', { name: /Goods In/ })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(rail.getByText('You are here')).toBeVisible();
      return;
    }

    // Portrait: behind the Menu button.
    const menu = page.getByRole('button', { name: /open menu/i });
    await expect(menu).toBeVisible();
    await menu.click();
    const drawer = page.getByRole('navigation', { name: /venue navigation/i });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: /Goods In/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(drawer.getByText('You are here')).toBeVisible();
  });

  test('B-7: every navigation target is at least 46px', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn');

    const rail = page.getByRole('navigation', { name: /venue navigation/i });
    if (!(await rail.isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: /open menu/i });
      const menuBox = await boxOf(menu);
      expect(menuBox.height).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(menuBox.width).toBeGreaterThanOrEqual(MIN_TARGET);
      await menu.click();
    }

    const items = page.locator('.venue-nav-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(5); // Home + 3 jobs + Sign out
    for (let i = 0; i < count; i += 1) {
      const box = await boxOf(items.nth(i));
      expect(box.height, `nav item ${i} is too small to tap`).toBeGreaterThanOrEqual(MIN_TARGET);
    }
  });

  test('B-7: it navigates, and the mark follows', async ({ page }) => {
    await gotoVenueScreen(page, 'goodsIn');

    const rail = page.getByRole('navigation', { name: /venue navigation/i });
    if (!(await rail.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /open menu/i }).click();
    }

    await page
      .getByRole('navigation', { name: /venue navigation/i })
      .getByRole('button', { name: /Stock Take/ })
      .click();

    await expect(page).toHaveURL(/\/pwa\/stock-take/);

    if (!(await rail.isVisible().catch(() => false))) {
      // The drawer closes behind the navigation — a menu left open covers the
      // screen you just chose.
      await expect(page.locator('.venue-drawer')).toHaveCount(0);
      await page.getByRole('button', { name: /open menu/i }).click();
    }
    await expect(
      page
        .getByRole('navigation', { name: /venue navigation/i })
        .getByRole('button', { name: /Stock Take/ }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('B-7: the PIN screen offers no navigation — nobody has signed in yet', async ({ page }) => {
    await page.goto('/pin-login');
    await expect(page.locator('.touch-app')).toBeVisible();
    await expect(page.getByRole('button', { name: /open menu/i })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: /venue navigation/i })).toHaveCount(0);
  });
});

test.describe('desktop sidebar', () => {
  test('B-7: collapses to an icon rail, and the state survives a reload', async ({ page }) => {
    await authenticatePage(page);
    await page.goto('/products');

    const sidebar = page.getByRole('complementary', { name: /main navigation/i });
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    // Expanded: the label is readable.
    await expect(sidebar.getByRole('link', { name: 'Products' })).toBeVisible();

    await page.getByRole('button', { name: /collapse navigation/i }).click();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');

    // Collapsed: the row is still there and still marked, just iconic.
    await expect(sidebar.getByRole('link', { name: 'Products' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.reload();
    await expect(page.getByRole('complementary', { name: /main navigation/i })).toHaveAttribute(
      'data-collapsed',
      'true',
    );

    // …and navigating with it collapsed still marks the new page.
    await page.getByRole('complementary', { name: /main navigation/i })
      .getByRole('link', { name: 'Sites' })
      .click();
    await expect(page).toHaveURL(/\/sites/);
    await expect(
      page.getByRole('complementary', { name: /main navigation/i })
        .getByRole('link', { name: 'Sites' }),
    ).toHaveAttribute('aria-current', 'page');

    // Put it back, so the next spec starts from the default.
    await page.getByRole('button', { name: /expand navigation/i }).click();
    await expect(page.getByRole('complementary', { name: /main navigation/i })).toHaveAttribute(
      'data-collapsed',
      'false',
    );
  });

  test('B-7: the breadcrumb names the section, agreeing with the highlight', async ({ page }) => {
    await authenticatePage(page);
    await page.goto('/stock/by-site');

    const crumb = page.getByRole('navigation', { name: /breadcrumb/i });
    await expect(crumb).toContainText('Stock by site');
    // /stock is a prefix of /stock/by-site — the breadcrumb must not disagree
    // with the sidebar about which of the two you are on.
    await expect(
      page.getByRole('complementary', { name: /main navigation/i })
        .getByRole('link', { name: 'Stock by site' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('B-7: the toggle is a 46px target', async ({ page }) => {
    await authenticatePage(page);
    await page.goto('/');
    const box = await boxOf(page.getByRole('button', { name: /collapse navigation/i }));
    expect(box.height).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TARGET);
  });
});
