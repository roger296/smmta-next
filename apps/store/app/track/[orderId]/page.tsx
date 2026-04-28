/**
 * /track/[orderId] — customer-facing order tracking.
 *
 * RSC reads `GET /storefront/orders/:id` from SMMTA-NEXT and renders:
 *   - status timeline (Confirmed → Allocated → Shipped → Delivered),
 *   - line items with quantities,
 *   - tracking number / link if the courier has one,
 *   - a "Re-send confirmation email" form pointing at /api/track/resend-email.
 *
 * `robots: noindex` — order URLs contain a UUID that should never be
 * indexed. We rely on the UUID itself for unguessability for v1; signed
 * tracking URLs are a follow-up.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPublicOrder } from '@/lib/smmta';
import { SmmtaApiError } from '@/lib/smmta';
import { ResendConfirmationButton } from './_components/resend-confirmation-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Track your order',
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ orderId: string }>;
}

const ORDERED_STATUSES: ReadonlyArray<string> = [
  'CONFIRMED',
  'ALLOCATED',
  'SHIPPED',
  'DELIVERED',
];

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED: 'Confirmed',
  ALLOCATED: 'Picked & packed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

/** Map a real order status to its index on the canonical timeline. Statuses
 *  the timeline doesn't list (BACK_ORDERED, ON_HOLD, etc.) collapse to the
 *  last "definitely-reached" milestone — for v1 that's CONFIRMED. */
function timelineIndex(status: string): number {
  const exact = ORDERED_STATUSES.indexOf(status);
  if (exact !== -1) return exact;
  if (['PARTIALLY_ALLOCATED', 'BACK_ORDERED', 'ON_HOLD'].includes(status)) {
    return 0; // we know they're past CONFIRMED but not yet ALLOCATED
  }
  return -1;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default async function TrackOrderPage({ params }: PageProps) {
  const { orderId } = await params;

  let order;
  try {
    order = await getPublicOrder(orderId);
  } catch (err) {
    if (err instanceof SmmtaApiError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  const reachedIndex = timelineIndex(order.status);
  const isCancelled = order.status === 'CANCELLED';

  // Build a quick lookup of "when did we reach status X" from the API's
  // statusHistory. CONFIRMED → orderDate; SHIPPED → shippedDate (if any).
  const reachedAt = new Map<string, string>();
  for (const entry of order.statusHistory) {
    reachedAt.set(entry.status, entry.at);
  }

  return (
    <section aria-labelledby="track-heading" className="space-y-8">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-[var(--brand-muted)]">
          Order
        </p>
        <h1
          id="track-heading"
          className="text-3xl font-semibold tracking-tight md:text-4xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {order.orderNumber}
        </h1>
        <p className="text-sm text-[var(--brand-muted)]">
          Placed {formatDateTime(order.orderDate)}
        </p>
      </header>

      {isCancelled ? (
        <p
          role="status"
          className="rounded-[var(--radius)] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          This order was cancelled. If you were expecting a refund and
          haven't received one, contact support and quote{' '}
          <strong>{order.orderNumber}</strong>.
        </p>
      ) : (
        <ol
          aria-label="Order status timeline"
          className="grid gap-3 md:grid-cols-4"
        >
          {ORDERED_STATUSES.map((status, idx) => {
            const reached = idx <= reachedIndex;
            const at = reachedAt.get(status);
            return (
              <li
                key={status}
                className={
                  reached
                    ? 'rounded-[var(--radius)] border border-emerald-200 bg-emerald-50 p-3'
                    : 'rounded-[var(--radius)] border border-dashed border-[var(--brand-border)] p-3 text-[var(--brand-muted)]'
                }
                aria-current={idx === reachedIndex ? 'step' : undefined}
              >
                <p className="text-xs uppercase tracking-wide">
                  Step {idx + 1}
                </p>
                <p className="text-sm font-medium">
                  {STATUS_LABELS[status] ?? status}
                </p>
                {reached && at ? (
                  <p className="text-xs">{formatDateTime(at)}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {order.tracking && (order.tracking.trackingNumber || order.tracking.trackingLink) ? (
        <section aria-labelledby="tracking-heading" className="space-y-2">
          <h2 id="tracking-heading" className="text-lg font-medium">
            Tracking
          </h2>
          <p className="text-sm">
            {order.tracking.courierName
              ? `${order.tracking.courierName}: `
              : ''}
            {order.tracking.trackingLink ? (
              <a
                href={order.tracking.trackingLink}
                rel="noopener noreferrer"
                target="_blank"
                className="text-[var(--brand-ink)] underline-offset-2 hover:underline"
              >
                {order.tracking.trackingNumber ?? 'View tracking'}
              </a>
            ) : (
              <code className="text-xs">{order.tracking.trackingNumber}</code>
            )}
          </p>
        </section>
      ) : null}

      <section aria-labelledby="lines-heading" className="space-y-3">
        <h2 id="lines-heading" className="text-lg font-medium">
          Items
        </h2>
        <ul className="divide-y divide-[var(--brand-border)] rounded-[var(--radius)] border border-[var(--brand-border)]">
          {order.lines.map((l, idx) => (
            <li
              key={`${l.productSlug ?? 'line'}-${idx}`}
              className="flex items-baseline justify-between gap-3 px-4 py-3 text-sm"
            >
              <div>
                <p className="font-medium">
                  {l.productName ?? l.productSlug ?? 'Product'}
                  {l.colour ? ` — ${l.colour}` : ''}
                </p>
                <p className="text-xs text-[var(--brand-muted)]">
                  Quantity {l.quantity} · £{l.pricePerUnit} each
                </p>
              </div>
              <p className="font-medium">£{l.lineTotal}</p>
            </li>
          ))}
        </ul>
        <div className="flex flex-col items-end gap-1 text-sm">
          <p>
            <span className="text-[var(--brand-muted)]">Subtotal: </span>£
            {order.totals.orderTotal}
          </p>
          <p>
            <span className="text-[var(--brand-muted)]">Shipping: </span>£
            {order.totals.deliveryCharge}
          </p>
          <p className="font-medium">
            <span className="text-[var(--brand-muted)]">Total: </span>£
            {order.totals.grandTotal}
          </p>
        </div>
      </section>

      <section aria-labelledby="resend-heading" className="space-y-2">
        <h2 id="resend-heading" className="text-lg font-medium">
          Need another copy of your confirmation?
        </h2>
        <p className="text-sm text-[var(--brand-muted)]">
          We&apos;ll re-send the original order confirmation to the email
          on file. (You can do this once an hour.)
        </p>
        <ResendConfirmationButton orderId={order.id} />
      </section>

      <p className="text-sm">
        <Link href="/" className="text-[var(--brand-muted)] hover:underline">
          ← Back to the storefront
        </Link>
      </p>
    </section>
  );
}
