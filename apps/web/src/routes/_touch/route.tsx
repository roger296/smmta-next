import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { ErrorBoundary } from '@/components/error-boundary';
import { SiteProvider } from '@/features/sites/site-context';
import { TouchViewportLock } from '@/components/touch/touch-viewport-lock';
import { VenueNav } from '@/components/touch/venue-nav';
import { TouchRouteFade } from '@/components/touch/touch-route-fade';
import { isAuthenticated } from '@/lib/auth';

/**
 * The venue (iPad) layout — Aug-2026 feedback set, defects B-1 … B-4.
 *
 * The four in-venue screens used to live under `_authed`, the **desktop admin
 * shell**: a `min-h-screen` flex layout with a sidebar, a header and a
 * `<main className="flex-1 overflow-auto p-6">`. `.touch-app` is
 * `position: fixed; inset: 0`, so it painted a full-screen overlay *on top of*
 * an admin page nobody could see or use — and the page underneath still
 * scrolled. When the iOS keyboard opened, the visual viewport shrank and the
 * fixed overlay was scrolled off the top of the glass with no way back:
 *
 *   "Screen formatting cuts off the top of the page rendering any initial line
 *    inputs invisible and uneditable."
 *
 * This layout has the same auth guard and the same `SiteProvider` — and
 * nothing else. No sidebar, no header, no padded `<main>`. The desktop admin
 * SPA is untouched.
 *
 * `PwaQueueSync` is deliberately NOT mounted here — it stays at the app root.
 * F2's note said F5 would move it; on reflection the root is the better home,
 * not a stopgap. A queue populated on a venue screen must replay wherever the
 * device happens to regain connectivity, including on `/pin-login` before
 * anyone has signed back in. Scoping the replayer to the venue layout would
 * leave unsent work sitting there until someone navigated back to a venue
 * screen — a smaller version of defect A-2, which was "nothing ever replays
 * it at all".
 *
 * Unauthenticated visitors go to `/pin-login`, not `/login`: someone who has
 * landed on a venue screen is standing at an iPad with a PIN, not at a desk
 * with an email address (defect E-2). `/login` stays reachable for office use.
 */
export const Route = createFileRoute('/_touch')({
  beforeLoad: ({ location }) => {
    if (!isAuthenticated()) {
      throw redirect({ to: '/pin-login', search: { redirect: location.href } });
    }
  },
  component: TouchLayout,
});

function TouchLayout() {
  return (
    <SiteProvider>
      {/* Body scroll lock + visual-viewport tracking, mounted once for the
          whole layout rather than per screen. */}
      <TouchViewportLock />
      {/* Navigational context for the venue screens (B-7): a persistent rail
          in landscape, a labelled Menu button + drawer in portrait. Wraps the
          Outlet so `TouchTopbar` can find it through context on every screen
          without each screen having to wire it up. */}
      <VenueNav>
        <ErrorBoundary>
          <TouchRouteFade>
            <Outlet />
          </TouchRouteFade>
        </ErrorBoundary>
      </VenueNav>
    </SiteProvider>
  );
}
