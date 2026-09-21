/**
 * Which sections of the admin a deployment shows.
 *
 * The platform carries screens a given business may never use: a
 * back-office deployment with no web shop has nothing to put on the
 * storefront-content, drop-ship or marketing pages. VITE_HIDDEN_SECTIONS,
 * baked in at build (Vite inlines VITE_* values), lists the sections to leave
 * out of the navigation as a comma-separated list of section keys. A key is
 * the section's route path without its leading slash; the dashboard is
 * `dashboard`. So: `digest,agents,chatbot,subscriptions,categories`.
 *
 * Hiding is navigation only. The routes still exist, so a bookmarked page
 * still opens; this is a tidier menu, not an access control.
 */

export function sectionKey(to: string): string {
  const key = to.replace(/^\/+/, '').replace(/\/+$/, '');
  return key === '' ? 'dashboard' : key;
}

export function parseHiddenSections(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => sectionKey(s.trim().toLowerCase()))
      .filter((s) => s !== 'dashboard' || raw?.toLowerCase().includes('dashboard')),
  );
}

export function visibleNavItems<T extends { to: string }>(items: T[], hidden: Set<string>): T[] {
  return items.filter((item) => !hidden.has(sectionKey(item.to)));
}

/** The sections this build hides, from VITE_HIDDEN_SECTIONS. */
export function hiddenSectionsFromEnv(): Set<string> {
  return parseHiddenSections(import.meta.env.VITE_HIDDEN_SECTIONS as string | undefined);
}
