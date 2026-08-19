/**
 * Whether the desktop sidebar is collapsed to an icon rail (Aug-2026, B-7).
 *
 * "Retaining a collapsible side menu might improve navigation confidence and
 * confirm the active page."
 *
 * Persisted, because a preference that resets on every reload is not a
 * preference. Kept in `localStorage` beside the token rather than in a cookie
 * or on the user record: it is a property of this browser, not of the account.
 */
const KEY = 'smmta_sidebar_collapsed';

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // Private-mode Safari throws on localStorage. Expanded is the safe default
    // — a nav nobody can read is worse than one that ignores a preference.
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(KEY, collapsed ? '1' : '0');
  } catch {
    // Nothing to do — the session still works, it just won't be remembered.
  }
}
