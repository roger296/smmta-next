/** Pre-order status lookup (no account needed). Customer enters their reference
 *  + email to see the status of a bank-transfer pre-order (SPEC §16.2). */
import type { Metadata } from 'next';
import { PreorderStatusLookup } from '@/components/preorder-status-lookup';

export const metadata: Metadata = { title: 'Pre-order status', robots: { index: false } };

export default function PreorderStatusPage() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-2 font-[var(--font-display)] text-2xl font-bold tracking-tight">Check your pre-order</h1>
      <p className="mb-5 text-sm text-[var(--brand-muted)]">
        Enter the reference from your confirmation and the email you used.
      </p>
      <PreorderStatusLookup />
    </div>
  );
}
