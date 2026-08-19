import * as React from 'react';

/**
 * Does this person want motion? (Aug-2026 feedback set, B-7.)
 *
 * "Page transitions feel quite abrupt" — so route changes now cross-fade. A
 * cross-fade is exactly the kind of thing `prefers-reduced-motion` exists to
 * switch off, and a venue iPad shared by a dozen people is precisely where
 * somebody's accessibility setting matters.
 *
 * Read through a hook rather than left to CSS alone so the *decision* is
 * testable, and so a component can skip the animating class entirely instead
 * of relying on a media query overriding it.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // jsdom and older Safari can throw on an unsupported query. Motion is the
    // default; a broken query must not disable the app.
    return false;
  }
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(prefersReducedMotion);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const onChange = () => setReduced(mq.matches);
    onChange();
    // Safari < 14 has no addEventListener on MediaQueryList.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener?.(onChange);
    return () => mq.removeListener?.(onChange);
  }, []);

  return reduced;
}
