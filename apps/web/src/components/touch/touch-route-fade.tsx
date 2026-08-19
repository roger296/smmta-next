import * as React from 'react';
import { useRouterState } from '@tanstack/react-router';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';

/**
 * The venue half of the B-7 cross-fade.
 *
 * Separate from `components/layout/route-fade.tsx` because it must NOT wrap
 * the screen in an extra box: `.touch-app` is `position: fixed; inset: 0`, and
 * a plain `<div>` around it would be a zero-height element the fixed child
 * ignores — the animation would apply to nothing. `React.cloneElement` is
 * wrong here too (the child is an Outlet). Instead this remounts the subtree
 * on a pathname change and hangs the animation off a wrapper that is itself
 * `display: contents`, so it adds no box at all.
 */
export function TouchRouteFade({ children }: { children: React.ReactNode }) {
  const { location } = useRouterState();
  const reduced = usePrefersReducedMotion();
  return (
    <div
      key={location.pathname}
      className={reduced ? 'touch-route' : 'touch-route touch-route-fade'}
      data-route-fade={reduced ? 'off' : 'on'}
    >
      {children}
    </div>
  );
}
