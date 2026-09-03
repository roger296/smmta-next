/**
 * Header search.
 *
 * The homepage was shipping WebSite schema declaring a sitelinks
 * SearchAction pointed at /shop?q={search_term_string}, while no search
 * input existed anywhere on the site and the parameter was ignored —
 * describing a feature that wasn't there. With 17 ranges across 5
 * materials and 23 colours, browsing alone is a lot of work, so the
 * feature was worth building rather than the schema worth deleting.
 *
 * Deliberately a plain <form method="GET"> and NOT a client component:
 * it needs no JavaScript to work, it degrades to a normal navigation,
 * and it keeps the header a server component. /shop reads `q` on the
 * server and hands it to the grid as initial state, so the results are
 * correct in the first paint for a crawler or a shared link.
 */
export function HeaderSearch({ className }: { className?: string }) {
  return (
    <form
      action="/shop"
      method="GET"
      role="search"
      className={`flex items-center ${className ?? ''}`}
    >
      <label htmlFor="site-search" className="sr-only">
        Search the filament range
      </label>
      <input
        id="site-search"
        type="search"
        name="q"
        placeholder="Search filament…"
        autoComplete="off"
        className="min-h-11 w-full min-w-0 border border-[var(--brand-border)] bg-[var(--brand-paper)] px-3 text-sm focus-visible:border-[var(--brand-ink)] focus-visible:outline-none"
      />
      <button
        type="submit"
        className="min-h-11 shrink-0 border border-l-0 border-[var(--brand-border)] bg-[var(--brand-ink)] px-4 text-xs font-semibold uppercase tracking-wider text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)]"
      >
        Search
      </button>
    </form>
  );
}
