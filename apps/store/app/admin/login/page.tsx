/**
 * /admin/login — the only un-gated path under /admin/*.
 *
 * The middleware lets this page through; everything else under /admin
 * redirects here when the cookie is missing/invalid. A `next` query
 * parameter carries the originally-requested path so the operator lands
 * back where they wanted after signing in.
 *
 * The form posts form-encoded to /api/admin/login (no JS required) — the
 * route handler sets the cookie and returns a 303 redirect.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { readAdminAuthCookie } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Admin sign in',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ next?: string; error?: string }>;
}

export default async function AdminLoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  // If the operator already has a valid cookie, bounce to the destination.
  const ok = await readAdminAuthCookie();
  if (ok) {
    redirect(params.next && params.next.startsWith('/') ? params.next : '/admin/refunds');
  }

  return (
    <section
      aria-labelledby="login-heading"
      className="mx-auto max-w-sm space-y-6 py-12"
    >
      <h1
        id="login-heading"
        className="text-2xl font-semibold"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Operator sign in
      </h1>
      <p className="text-sm text-[var(--brand-muted)]">
        Enter the operator key to access refunds + diagnostics.
      </p>

      <form
        method="POST"
        action="/api/admin/login"
        className="space-y-4"
        aria-describedby={params.error ? 'login-error' : undefined}
      >
        {params.next ? <input type="hidden" name="next" value={params.next} /> : null}
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Operator key</span>
          <input
            type="password"
            name="key"
            required
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-[var(--radius)] border border-[var(--brand-border)] px-3 py-2"
          />
        </label>
        {params.error ? (
          <p id="login-error" className="text-sm text-red-700" role="alert">
            Invalid key — try again.
          </p>
        ) : null}
        <button
          type="submit"
          className="w-full rounded-[var(--radius)] bg-[var(--brand-ink)] px-4 py-2 text-sm font-medium text-[var(--brand-paper)]"
        >
          Sign in
        </button>
      </form>
    </section>
  );
}
