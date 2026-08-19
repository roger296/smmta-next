/**
 * Navigation confidence (Aug-2026 feedback set, B-7).
 *
 * "Page transitions feel quite abrupt; retaining a collapsible side menu might
 *  improve navigation confidence and confirm the active page."
 *
 * Three separate claims are pinned here: the collapse preference survives a
 * reload, the current page is confirmed in words as well as colour, and the
 * cross-fade is skipped for anyone who has asked for reduced motion.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readSidebarCollapsed, writeSidebarCollapsed } from '@/lib/sidebar-state';
import { RouteFade } from './route-fade';
import { prefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';
import { activeJob, VENUE_JOBS } from '@/components/touch/venue-nav';
import { sectionLabel } from './header';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tanstack/react-router');
  return {
    ...actual,
    useRouterState: () => ({ location: { pathname: '/products' } }),
    useNavigate: () => vi.fn(),
  };
});

/** Replace matchMedia — jsdom has none at all, so `vi.spyOn` cannot work. */
function stubMatchMedia(matches: (query: string) => boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe('the collapse preference persists', () => {
  it('defaults to expanded — a nav nobody can read is worse than an ignored setting', () => {
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('round-trips through localStorage, which is what surviving a reload means', () => {
    writeSidebarCollapsed(true);
    expect(readSidebarCollapsed()).toBe(true);
    writeSidebarCollapsed(false);
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('survives localStorage throwing (private-mode Safari) rather than crashing the shell', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readSidebarCollapsed()).toBe(false);
    expect(() => writeSidebarCollapsed(true)).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('the breadcrumb confirms the active page', () => {
  it('names the section, and agrees with the nav highlight by construction', () => {
    expect(sectionLabel('/stock/by-site')).toBe('Stock by site');
    // /stock is a prefix of /stock/by-site — the breadcrumb must not say
    // "Stock" on a page the sidebar highlights as "Stock by site".
    expect(sectionLabel('/stock')).toBe('Stock');
    expect(sectionLabel('/')).toBe('Dashboard');
  });

  it('says nothing rather than guessing on a page that is not in the nav', () => {
    expect(sectionLabel('/customers/new')).toBeNull();
  });
});

describe('the venue rail knows which job you are on', () => {
  it('marks the current job', () => {
    expect(activeJob('/pwa/goods-in')).toBe('/pwa/goods-in');
    expect(activeJob('/pwa/consumption')).toBe('/pwa/consumption');
    expect(activeJob('/venue')).toBe('/venue');
  });

  it('marks nothing on a screen that is not one of the jobs', () => {
    expect(activeJob('/pin-login')).toBeNull();
  });

  it('offers Home plus the three jobs — nothing from the desktop admin menu', () => {
    expect(VENUE_JOBS.map((j) => j.label)).toEqual([
      'Home',
      'Goods In',
      'End of Bake',
      'Stock Take',
    ]);
  });
});

describe('prefers-reduced-motion', () => {
  it('drops the animating class entirely, rather than relying on a CSS override', () => {
    stubMatchMedia((q) => q.includes('prefers-reduced-motion'));
    render(
      <RouteFade>
        <p>Page body</p>
      </RouteFade>,
    );
    const wrapper = screen.getByText('Page body').parentElement!;
    expect(wrapper.getAttribute('data-route-fade')).toBe('off');
    expect(wrapper.className).not.toContain('route-fade');
  });

  it('animates when motion is fine', () => {
    stubMatchMedia(() => false);
    render(
      <RouteFade>
        <p>Page body</p>
      </RouteFade>,
    );
    const wrapper = screen.getByText('Page body').parentElement!;
    expect(wrapper.getAttribute('data-route-fade')).toBe('on');
    expect(wrapper.className).toContain('route-fade');
  });

  it('treats a missing matchMedia as "motion is fine" rather than throwing', () => {
    // Some embedded WebViews genuinely have no matchMedia.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: undefined,
    });
    expect(prefersReducedMotion()).toBe(false);
  });
});
