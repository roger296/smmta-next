/**
 * /admin/refunds/[paymentId] — payment detail + issue-refund form.
 *
 * RSC reads the local mollie_payments + mollie_refunds rows via
 * `getPaymentDetail`. The form is a small client island that POSTs to
 * /api/admin/refunds and refreshes the route on success.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPaymentDetail } from '@/lib/refunds';
import { IssueRefundForm } from './_components/issue-refund-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Refund payment',
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ paymentId: string }>;
}

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

export default async function PaymentDetailPage({ params }: PageProps) {
  const { paymentId } = await params;
  const detail = await getPaymentDetail(paymentId);
  if (!detail) {
    notFound();
  }

  const amountPence = Math.round(Number.parseFloat(detail.amountGbp) * 100);
  const refundedPence = Math.round(Number.parseFloat(detail.refundedGbp) * 100);
  const remainingPence = Math.max(0, amountPence - refundedPence);
  const remainingGbp = (remainingPence / 100).toFixed(2);
  const fullyRefunded = remainingPence === 0;

  return (
    <section aria-labelledby="payment-heading" className="space-y-6">
      <p className="text-sm">
        <Link href="/admin/refunds" className="text-[var(--brand-muted)] hover:underline">
          ← All payments
        </Link>
      </p>
      <header className="space-y-1">
        <h1
          id="payment-heading"
          className="text-2xl font-semibold"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Payment {detail.paymentId}
        </h1>
        <p className="text-sm text-[var(--brand-muted)]">
          Created {formatDate(detail.createdAt)} · {detail.method ?? 'method unknown'}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-[var(--radius)] border border-[var(--brand-border)] p-4 text-sm md:grid-cols-3">
        <div>
          <dt className="text-xs uppercase text-[var(--brand-muted)]">Status</dt>
          <dd className="font-medium">{detail.status}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-[var(--brand-muted)]">Amount</dt>
          <dd className="font-medium">{formatGbp(detail.amountGbp, detail.currency)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-[var(--brand-muted)]">Refunded</dt>
          <dd className="font-medium">
            {formatGbp(detail.refundedGbp, detail.currency)}
            <span className="ml-1 text-xs text-[var(--brand-muted)]">
              ({detail.refundsToDate}×)
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-[var(--brand-muted)]">Remaining</dt>
          <dd className="font-medium">{formatGbp(remainingGbp, detail.currency)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-[var(--brand-muted)]">Customer</dt>
          <dd>
            {detail.customerName ?? '—'}
            {detail.customerEmail ? (
              <span className="block text-[var(--brand-muted)]">{detail.customerEmail}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-[var(--brand-muted)]">SMMTA order</dt>
          <dd>
            {detail.smmtaOrderId ? (
              <code className="text-xs">{detail.smmtaOrderId}</code>
            ) : (
              <span className="text-[var(--brand-muted)]">—</span>
            )}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="issue-heading" className="space-y-3">
        <h2 id="issue-heading" className="text-lg font-medium">
          Issue refund
        </h2>
        {fullyRefunded ? (
          <p className="rounded-[var(--radius)] border border-dashed border-[var(--brand-border)] p-4 text-sm text-[var(--brand-muted)]">
            This payment has been fully refunded.
          </p>
        ) : (
          <IssueRefundForm
            paymentId={detail.paymentId}
            remainingGbp={remainingGbp}
            currency={detail.currency}
          />
        )}
      </section>

      <section aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="text-lg font-medium">
          Refund history
        </h2>
        {detail.refunds.length === 0 ? (
          <p className="text-sm text-[var(--brand-muted)]">No refunds yet.</p>
        ) : (
          <ul className="space-y-2">
            {detail.refunds.map((r) => (
              <li
                key={r.id}
                className="rounded-[var(--radius)] border border-[var(--brand-border)] p-3 text-sm"
              >
                <div className="flex items-center justify-between">
                  <code className="text-xs">{r.id}</code>
                  <span className="text-xs text-[var(--brand-muted)]">
                    {formatDate(r.createdAt)}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="font-medium">
                    {formatGbp(r.amountGbp, r.currency)}
                  </span>
                  <span className="text-xs">{r.status}</span>
                </div>
                {r.smmtaCreditNoteId ? (
                  <p className="mt-1 text-xs text-[var(--brand-muted)]">
                    Credit note: <code>{r.smmtaCreditNoteId}</code>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
