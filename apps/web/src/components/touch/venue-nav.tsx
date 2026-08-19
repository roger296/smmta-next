import * as React from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { clearToken } from '@/lib/auth';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';

/**
 * Navigational context for the venue screens (Aug-2026 feedback set, B-7).
 *
 * "Page transitions feel quite abrupt; retaining a collapsible side menu might
 * improve navigation confidence and confirm the active page."
 *
 * After F5 the venue screens are their own layout, with none of the desktop
 * chrome — which fixed B-1…B-4 and removed the only thing on screen that said
 * where you were. This puts that back on the venue's own terms: a slim rail in
 * landscape, where there is width to spare, and a labelled Menu button opening
 * a drawer in portrait, where there isn't.
 *
 * The current job is marked three ways — a salmon ground, a bold label, and
 * `aria-current="page"` — because "confirm the active page" is the request and
 * colour alone confirms it to nobody using a screen reader.
 *
 * Plain CSS in `pwa-touch.css`, not Tailwind: the touch layer is deliberately
 * kept out of the admin SPA's design system, and every target here is ≥ 46 px.
 */
export const VENUE_JOBS = [
  { to: '/venue', label: 'Home', hint: 'The three jobs' },
  { to: '/pwa/goods-in', label: 'Goods In', hint: 'Book in a delivery' },
  { to: '/pwa/consumption', label: 'End of Bake', hint: 'Record what was used' },
  { to: '/pwa/stock-take', label: 'Stock Take', hint: 'Count the shelf' },
] as const;

/**
 * Which job is current. Exact match or a child path — the venue routes have no
 * shared prefixes, so there is no longest-match subtlety here (unlike the
 * desktop `activePath`, where /stock is a prefix of /stock/by-site).
 */
export function activeJob(pathname: string): string | null {
  return (
    VENUE_JOBS.find((j) => pathname === j.to || pathname.startsWith(`${j.to}/`))?.to ?? null
  );
}

interface VenueNavValue {
  /** Open the drawer. Only meaningful when the rail is not persistent. */
  open: () => void;
  /** True when the rail is shown permanently beside the screen (landscape). */
  isRail: boolean;
}

const VenueNavContext = React.createContext<VenueNavValue | null>(null);

/**
 * Null outside the venue layout — `TouchTopbar` uses that to decide whether to
 * render a Menu button at all. The PIN screen is a touch screen but not a
 * venue screen: it must not offer navigation to someone who has not signed in.
 */
export function useVenueNav(): VenueNavValue | null {
  return React.useContext(VenueNavContext);
}

/** The width the rail takes when it is persistent. Mirrors `pwa-touch.css`. */
const RAIL_QUERY = '(min-width: 900px)';

function useRailVisible(): boolean {
  const [visible, setVisible] = React.useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try {
      return window.matchMedia(RAIL_QUERY).matches;
    } catch {
      return false;
    }
  });

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(RAIL_QUERY);
    } catch {
      return;
    }
    const onChange = () => setVisible(mq.matches);
    onChange();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener?.(onChange);
    return () => mq.removeListener?.(onChange);
  }, []);

  return visible;
}

function JobList({
  current, onPick, variant,
}: {
  current: string | null;
  onPick: (to: string) => void;
  variant: 'rail' | 'drawer';
}) {
  return (
    <>
      {VENUE_JOBS.map((job) => {
        const isCurrent = current === job.to;
        return (
          <button
            key={job.to}
            type="button"
            className={`venue-nav-item${isCurrent ? ' current' : ''}`}
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => onPick(job.to)}
          >
            <span className="venue-nav-label">{job.label}</span>
            {variant === 'drawer' && <span className="venue-nav-hint">{job.hint}</span>}
            {isCurrent && <span className="venue-nav-here">You are here</span>}
          </button>
        );
      })}
    </>
  );
}

export function VenueNav({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { location } = useRouterState();
  const isRail = useRailVisible();
  const reduced = usePrefersReducedMotion();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const current = activeJob(location.pathname);

  // The rail sits outside `.touch-app` (which is a fixed, full-screen overlay
  // — see `pwa-touch.css`), so the overlay has to be shifted out of its way.
  // A class on <html> rather than a global custom property, because
  // `/pin-login` is a `.touch-app` screen that is NOT inside this layout and
  // must not be indented by a rail it never renders.
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('venue-rail-open', isRail);
    return () => root.classList.remove('venue-rail-open');
  }, [isRail]);

  // A drawer left open across a navigation covers the screen you just chose.
  React.useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const value = React.useMemo<VenueNavValue>(
    () => ({ open: () => setDrawerOpen(true), isRail }),
    [isRail],
  );

  const go = (to: string) => {
    setDrawerOpen(false);
    void navigate({ to });
  };

  const signOut = () => {
    clearToken();
    // The device's venue binding stays — it belongs to the iPad, not to
    // whoever last tapped a PIN in (B-5).
    void navigate({ to: '/pin-login' });
  };

  return (
    <VenueNavContext.Provider value={value}>
      {isRail && (
        <nav className="venue-rail" aria-label="Venue navigation">
          <div className="venue-rail-brand">Big Bakes</div>
          <JobList current={current} onPick={go} variant="rail" />
          <div className="venue-rail-spacer" />
          <button type="button" className="venue-nav-item signout" onClick={signOut}>
            <span className="venue-nav-label">Sign out</span>
          </button>
        </nav>
      )}

      {children}

      {!isRail && drawerOpen && (
        <>
          <div
            className="venue-drawer-scrim"
            role="presentation"
            onClick={() => setDrawerOpen(false)}
          />
          <nav
            className={`venue-drawer${reduced ? ' no-motion' : ''}`}
            aria-label="Venue navigation"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDrawerOpen(false);
            }}
          >
            <div className="venue-drawer-head">
              <span className="venue-rail-brand">Big Bakes Stock</span>
              <button
                type="button"
                className="venue-drawer-close"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
              >
                ×
              </button>
            </div>
            <JobList current={current} onPick={go} variant="drawer" />
            <div className="venue-rail-spacer" />
            <button type="button" className="venue-nav-item signout" onClick={signOut}>
              <span className="venue-nav-label">Sign out</span>
            </button>
          </nav>
        </>
      )}
    </VenueNavContext.Provider>
  );
}
