/**
 * Venue-screen (touch layer) e2e helpers — Aug-2026 feedback set, F1.
 *
 * The 12 Aug test failed on the iPad in a way no desktop spec could see: the
 * top of the screen was cut off and the first line inputs were invisible and
 * uneditable (defect B-1). These helpers exist so every venue spec can make
 * that assertion cheaply and identically.
 */
import { expect, type Page } from '@playwright/test';
import { authenticatePage } from './auth';

export const VENUE_SCREENS = {
  goodsIn: '/pwa/goods-in',
  stockTake: '/pwa/stock-take',
  consumption: '/pwa/consumption',
} as const;

export type VenueScreen = keyof typeof VENUE_SCREENS;

/**
 * Sign in the way a venue iPad does. A live API is not assumed: when
 * `stubPinLogin` is on, `POST /auth/pin-login` is fulfilled locally with a
 * token minted by the API's own generator, so the PIN screen's happy path is
 * exercised without a server.
 */
export async function signInWithPin(
  page: Page,
  opts: { pin?: string; siteId?: string; siteName?: string; roles?: string[]; stub?: boolean } = {},
): Promise<void> {
  const { pin = '1234', siteId = 'site-london-south', siteName = 'London South', roles = ['head_baker'] } = opts;
  const stub = opts.stub ?? true;

  if (stub) {
    await page.route('**/auth/pin-login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { token: await fakeToken(page), user: { label: 'Test Baker', roles, siteId, siteName } },
        }),
      });
    });
  }

  await page.goto('/pin-login');
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  // Exact: the PIN screen also carries "Sign in with email instead" (E-2's
  // office fallback), which a loose match picks up too.
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** A signed JWT for the SPA to hold; generated once per process by the API. */
async function fakeToken(page: Page): Promise<string> {
  const { getOrGenerateToken } = await import('./auth');
  void page;
  return getOrGenerateToken();
}

/** The venue every venue spec runs against unless it says otherwise. */
export const TEST_VENUE = { id: 'site-1', slug: 'london-south', name: 'London South' };

/**
 * Stub `/sites` so the screens have a real venue to name. `/sites` is a plain
 * (non-paginated) list — the envelope must NOT carry total/page, or `apiFetch`
 * unwraps it as a PaginatedResult and `sites` arrives as an object.
 */
export interface StubSite {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  /** Benches per table (F-7). Absent / null = "not set for this venue". */
  benchesPerTable?: string | null;
}

export async function stubSites(
  page: Page,
  sites: StubSite[] = [{ ...TEST_VENUE, isActive: true }],
): Promise<void> {
  await page.route('**/api/v1/sites**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: sites }),
    }),
  );
}

/**
 * Stub the product lookups a Goods In spec needs.
 *
 * `GET /products/by-code/:code` answers with ONE product, not a page. A single
 * `**\/api/v1/products**` route also matches `/products/by-code/…`, and the
 * paginated envelope it returns makes `apiFetch<Product>` unwrap to a
 * `PaginatedResult` — so the screen adds a line with no name and the spec
 * looks for a product that was never rendered. Register the exact route
 * second: Playwright's LAST-registered handler wins.
 */
export async function stubProducts(
  page: Page,
  products: Array<Record<string, unknown>>,
): Promise<void> {
  await page.route('**/api/v1/products**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: products,
        total: products.length,
        page: 1,
        pageSize: 50,
        totalPages: 1,
      }),
    }),
  );
  await page.route('**/api/v1/products/by-code/**', (route) => {
    const code = decodeURIComponent(route.request().url().split('/by-code/')[1] ?? '');
    const match = products.find(
      (p) => p.barcode === code || p.stockCode === code || p.ean === code,
    );
    if (!match) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'No product carries that code' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: match }),
    });
  });
}

/**
 * Land straight on a venue screen with a token already in localStorage.
 *
 * `stubSites` is only applied when the caller has not already stubbed `/sites`
 * itself — Playwright's LAST-registered route handler wins, so stubbing here
 * unconditionally would silently override a spec's own site fixture (which is
 * exactly how the bench specs first "failed").
 */
export async function gotoVenueScreen(
  page: Page,
  screen: VenueScreen,
  opts: { sites?: StubSite[] | false } = {},
): Promise<void> {
  await authenticatePage(page);
  if (opts.sites !== false) await stubSites(page, opts.sites);
  await page.goto(VENUE_SCREENS[screen]);
  await expect(page.locator('.touch-app')).toBeVisible();
}

/**
 * The B-1 assertion. The topbar must sit *fully inside* the viewport — not
 * merely exist in the DOM — and the first interactive control in the scroll
 * body must be hit-testable. On 12 Aug both were false after the keyboard
 * opened, and there was no way to scroll back.
 */
export async function expectTopbarVisible(page: Page): Promise<void> {
  const topbar = page.locator('.touch-app .topbar').first();
  await expect(topbar).toBeVisible();

  const box = await topbar.boundingBox();
  expect(box, 'topbar has no bounding box — it is not laid out').not.toBeNull();

  const viewport = page.viewportSize();
  expect(viewport, 'no viewport size — cannot assert against the glass').not.toBeNull();

  // Fully inside the viewport, top and bottom. A negative `y` is exactly the
  // 12 Aug symptom: the fixed overlay scrolled off the top of the glass.
  expect(box!.y, 'topbar has scrolled off the top of the viewport').toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height, 'topbar sits below the fold').toBeLessThanOrEqual(viewport!.height + 1);
}

/**
 * The first interactive element inside the scrolling body is reachable — an
 * "invisible and uneditable" first line is the other half of B-1.
 */
export async function expectFirstBodyControlHittable(page: Page): Promise<void> {
  const control = page
    .locator('.touch-app .scroll')
    .locator('button, input, select, textarea, [role="button"]')
    .first();
  const count = await control.count();
  if (count === 0) return; // an empty screen has nothing to reach — not a failure
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box, 'first body control has no bounding box').not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.y + box!.height, 'first body control is above the top of the glass').toBeGreaterThan(0);
  expect(box!.y, 'first body control is below the fold').toBeLessThan(viewport.height);
}

/** Focus the first text input in the scroll body (what opens the keyboard). */
export async function focusFirstInput(page: Page): Promise<boolean> {
  const input = page.locator('.touch-app input:not([type="hidden"])').first();
  if ((await input.count()) === 0) return false;
  await input.focus();
  return true;
}

/** Assert nothing is focused on mount — the B-2 regression (autoFocus). */
export async function expectNoInputFocusedOnMount(page: Page): Promise<void> {
  const tag = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase() ?? 'body');
  expect(tag, 'an input took focus on mount — the venue keyboard opens unbidden').not.toBe('input');
}
