/**
 * Is this an installed PWA rather than a browser tab? (Aug-2026 feedback, E-2.)
 *
 * "Adding the iPad PIN login page to the home screen redirects incorrectly to
 * the standard email login page." Fixing `start_url` alone is not enough: an
 * installed icon can land on `/` for other reasons (a saved state, a
 * navigation, an older install), and `/` is under `_authed`, which sends an
 * unauthenticated visitor to `/login`.
 *
 * So the redirect is chosen by **how the app was opened**, not by guesswork.
 * A home-screen launch is a venue iPad and belongs on the PIN screen; a
 * browser tab is somebody at a desk and belongs on the email form.
 *
 * `display-mode: standalone` is the standard signal; `navigator.standalone` is
 * the older iOS-only one, still what an iPad added to the home screen reports.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;

  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  if (iosStandalone === true) return true;

  if (typeof window.matchMedia !== 'function') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches
  );
}

/**
 * Where an unauthenticated visitor should be sent. The venue screens always
 * mean the PIN screen; `/` means the PIN screen only when the app was launched
 * from a home-screen icon.
 */
export function signInRouteFor(pathname: string): '/pin-login' | '/login' {
  if (pathname.startsWith('/pwa/') || pathname.startsWith('/venue')) return '/pin-login';
  return isStandaloneDisplay() ? '/pin-login' : '/login';
}
