/**
 * What a slow route shows while it loads (Aug-2026 feedback set, B-7).
 *
 * The tester's complaint was that transitions "feel quite abrupt". Half of
 * that is the swap itself; the other half is a screen that goes blank while a
 * loader runs and gives no sign anything is happening. A skeleton says "this
 * is the page you asked for, it is coming" — a blank panel says nothing.
 *
 * `pulse` is suppressed under `prefers-reduced-motion` by Tailwind's
 * `motion-reduce` variant; the shapes stay, so the message survives.
 */
export function RoutePending() {
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="h-7 w-56 animate-pulse rounded-md bg-[var(--color-muted)] motion-reduce:animate-none" />
      <div className="h-4 w-80 animate-pulse rounded-md bg-[var(--color-muted)] motion-reduce:animate-none" />
      <div className="space-y-2 pt-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-12 animate-pulse rounded-md bg-[var(--color-muted)] motion-reduce:animate-none"
          />
        ))}
      </div>
    </div>
  );
}
