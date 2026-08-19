/**
 * Which sign-in screen an unauthenticated visitor gets (Aug-2026, E-2).
 *
 * Fixing `start_url` alone was not enough: an installed icon can still land on
 * `/` (a saved state, a navigation, an older install), and `/` redirected
 * everyone to the email form. The choice is made from HOW THE APP WAS OPENED.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStandaloneDisplay, signInRouteFor } from './display-mode';

/**
 * jsdom does not implement `window.matchMedia`, so this defines it rather than
 * spying on it — and that absence is itself worth noting: `isStandaloneDisplay`
 * guards for it, because a browser without the API must answer "not
 * standalone" rather than throw on the auth redirect path.
 */
function mockDisplayMode(standalone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: standalone && query.includes('standalone'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'matchMedia');
  delete (navigator as Navigator & { standalone?: boolean }).standalone;
});

describe('isStandaloneDisplay', () => {
  it('answers false — not throws — when matchMedia is unavailable', () => {
    // This runs on the auth redirect path; a throw here would be a white
    // screen instead of a sign-in page.
    expect(() => isStandaloneDisplay()).not.toThrow();
    expect(isStandaloneDisplay()).toBe(false);
  });

  it('true for display-mode: standalone', () => {
    mockDisplayMode(true);
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('true for the older iOS navigator.standalone — what an iPad reports', () => {
    mockDisplayMode(false);
    (navigator as Navigator & { standalone?: boolean }).standalone = true;
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('false in an ordinary browser tab', () => {
    mockDisplayMode(false);
    expect(isStandaloneDisplay()).toBe(false);
  });
});

describe('signInRouteFor (E-2)', () => {
  it('a venue screen always means the PIN screen, tab or not', () => {
    mockDisplayMode(false);
    expect(signInRouteFor('/pwa/goods-in')).toBe('/pin-login');
    expect(signInRouteFor('/pwa/stock-take')).toBe('/pin-login');
    expect(signInRouteFor('/venue')).toBe('/pin-login');
  });

  it('E-2: `/` from a home-screen icon means the PIN screen', () => {
    mockDisplayMode(true);
    expect(signInRouteFor('/')).toBe('/pin-login');
  });

  it('`/` in a browser tab still means the email form — office users need it', () => {
    mockDisplayMode(false);
    expect(signInRouteFor('/')).toBe('/login');
    expect(signInRouteFor('/products')).toBe('/login');
  });
});
