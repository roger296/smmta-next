/**
 * /admin/refunds — list of recent paid Mollie payments with refund status.
 *
 * RSC pulled directly from `lib/refunds.listRecentPaidPayments`. Each row
 * links to the detail page where the operator can issue a refund.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { listRecentPaidPayments } from '@/lib/refunds';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Refunds',
  robots: { index: false, follow: false },
};

function formatGbp(value: string, currency: string): string {
  if (currency === 'GBP') return `£${value}`;
  return `${currency} ${value}`;
}

function formatDate(date: Date): string {
  return date.toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function AdminRefundsPage() {
  const rows = await listRecentPaidPayments(50);

  return (
    <section aria-labelledby="refunds-heading" className="space-y-4">
      <h1
        id="refunds-heading"
        className="text-2xl font-semibold"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Recent payments
      </h1>
      <p className="text-sm text-[var(--brand-muted)]">
        Most recent {rows.length} payment{rows.length === 1 ? '' : 's'}. Click a
        row to issue a refund. Customer emails are sent automatically when a
        refund is issued.
      </p>

      {rows.length === 0 ? (
        <p className="rounded-[var(--radius)] border border-dashed border-[var(--brand-border)] p-6 text-sm text-[var(--brand-muted)]">
          No payments yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--brand-border)]">
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--brand-paper)] text-xs uppercase text-[var(--brand-muted)]">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Created
                </th>
                <th scope="col" className="px-3 py-2">
                  Customer
                </th>
                <th scope="col" className="px-3 py-2">
                  SMMTA order
                </th>
                <th scope="col" className="px-3 py-2">
                  Method
                </th>
                <th scope="col" className="px-3 py-2">
                  Amount
                </th>
                <th scope="col" className="px-3 py-2">
                  Refunded
                </th>
                <th scope="col" className="px-3 py-2">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const amountPence = Math.round(Number.parseFloat(r.amountGbp) * 100);
                const refundedPence = Math.round(
                  Number.parseFloat(r.refundedGbp) * 100,
                );
                const fullyRefunded = refundedPence >= amountPence && amountPence > 0;
                return (
                  <tr
                    key={r.paymentId}
                    className="border-t border-[var(--brand-border)]"
                  >
                    <td className="px-3 py-2">{formatDate(r.createdAt)}</td>
                    <td className="px-3 py-2">
                      {r.customerName ?? r.customerEmail ?? (
                        <span className="text-[var(--brand-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.smmtaOrderId ? (
                        <code className="text-xs">{r.smmtaOrderId.slice(0, 8)}…</code>
                      ) : (
                        <span className="text-[var(--brand-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.method ?? '—'}</td>
                    <td className="px-3 py-2">{formatGbp(r.amountGbp, r.currency)}</td>
                    <td className="px-3 py-2">
                      {refundedPence === 0 ? (
                        <span className="text-[var(--brand-muted)]">—</span>
                      ) : (
                        <>
                          {formatGbp(r.refundedGbp, r.currency)}
                          <span className="ml-1 text-xs text-[var(--brand-muted)]">
                            ({r.refundsToDate}×)
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          fullyRefunded
                            ? 'rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-900'
                            : refundedPence > 0
                              ? 'rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-900'
                              : 'rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-900'
                        }
                      >
                        {fullyRefunded
                          ? 'fully refunded'
                          : refundedPence > 0
                            ? 'partial'
                            : r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/admin/refunds/${encodeURIComponent(r.paymentId)}`}
                        className="text-[var(--brand-ink)] underline-offset-2 hover:underline"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
