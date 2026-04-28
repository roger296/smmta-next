/**
 * /admin layout — wraps every admin page in a slim header that shows the
 * "operator" badge and a sign-out form. Pages themselves are gated by the
 * Edge middleware; this layout doesn't repeat that check (would race with
 * the cookie write in the login route).
 */
import type { Metadata } from 'next';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s — Admin | Filament Store' },
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <nav
        aria-label="Admin"
        className="flex items-center justify-between border-b border-[var(--brand-border)] pb-3 text-sm"
      >
        <ul className="flex items-center gap-4">
          <li>
            <Link href="/admin/refunds" className="font-medium hover:underline">
              Refunds
            </Link>
          </li>
        </ul>
        <form method="POST" action="/api/admin/logout">
          <button
            type="submit"
            className="text-[var(--brand-muted)] hover:text-[var(--brand-ink)] hover:underline"
          >
            Sign out
          </button>
        </form>
      </nav>
      {children}
    </div>
  );
}
