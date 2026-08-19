import * as React from 'react';
import { useRouterState } from '@tanstack/react-router';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';

/**
 * A short cross-fade on route change (Aug-2026 feedback set, B-7).
 *
 * "Page transitions feel quite abrupt; retaining a collapsible side menu might
 * improve navigation confidence and confirm the active page."
 *
 * Keyed on the pathname, so React remounts the subtree and the fade-in
 * animation restarts. 140ms — long enough to read as a change of page, short
 * enough that nobody waiting on it notices.
 *
 * Under `prefers-reduced-motion` the animating class is omitted entirely
 * rather than overridden in CSS: the key still changes, the content still
 * swaps, there is simply no animation to cancel.
 */
export function RouteFade({ children }: { children: React.ReactNode }) {
  const { location } = useRouterState();
  const reduced = usePrefersReducedMotion();
  return (
    <div key={location.pathname} className={reduced ? undefined : 'route-fade'} data-route-fade={reduced ? 'off' : 'on'}>
      {children}
    </div>
  );
}
