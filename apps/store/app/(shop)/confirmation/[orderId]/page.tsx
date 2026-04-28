/**
 * /confirmation/[orderId] — RSC reads /storefront/orders/:id and shows
 * the customer's order summary. Robots: noindex.
 *
 * Triggers an `email_outbox` insert for `order_confirmation`. The unique
 * index on `(order_id, template)` makes this idempotent — re-rendering
 * the page (e.g. customer hits refresh) doesn't enqueue a second email.
 * The actual SendGrid send lands in Prompt 11; here we only enqueue.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { emailOutbox, checkouts } from '@/drizzle/schema';
import { smmtaFetch, SmmtaApiError } from '@/lib/smmta';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Order confirmation',
  robots: { index: false, follow: false },
};

interface PublicOrder {
  id: string;
  orderNumber: string;
  status: string;
  orderDate: string;
  currencyCode: string;
  totals: {
    orderTotal: string;
    taxTotal: string;
    deliveryCharge: string;
    grandTotal: string;
  };
  lines: Array<{
    productSlug: string | null;
    productName: string | null;
    colour: string | null;
    quantity: number;
    pricePerUnit: string;
    lineTotal: string;
  }>;
  deliveryAddress: { line1: string; city: string; postCode: string } | null;
}

/** Insert a `order_confirmation` outbox row, idempotent via the unique
 *  partial index on `(order_id, template)`. */
async function enqueueConfirmationEmail(
  orderId: string,
  toEmail: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  // ON CONFLICT DO NOTHING via a try/catch — the unique index throws on
  // duplicate. Cheap and clear; no need for raw SQL.
  try {
    await db.insert(emailOutbox).values({
      toEmail,
      template: 'order_confirmation',
      payload,
      sendStatus: 'PENDING',
      orderId,
    });
  } catch {
    // Already enqueued — fine.
  }
}

export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const db = getDb();

  let order: PublicOrder;
  try {
    order = await smmtaFetch<PublicOrder>(`storefront/orders/${encodeURIComponent(orderId)}`, {
      revalidate: false,
    });
  } catch (err) {
    if (err instanceof SmmtaApiError && err.status === 404) notFound();
    throw err;
  }

  // Best-effort: enqueue the confirmation email. Pull the customer's email
  // from the local checkouts row that drove this order.
  const checkoutRow = await db.query.checkouts.findFirst({
    where: and(eq(checkouts.smmtaOrderId, orderId)),
  });
  const customer = checkoutRow?.customer as
    | { email?: string; firstName?: string; lastName?: string }
    | null
    | undefined;
  if (customer?.email) {
    await enqueueConfirmationEmail(orderId, customer.email, {
      orderId,
      orderNumber: order.orderNumber,
      grandTotal: order.totals.grandTotal,
      currency: order.currencyCode,
      firstName: customer.firstName,
      lastName: customer.lastName,
    });
  }

  return (
    <section aria-labelledby="thanks-heading" className="space-y-6">
      <h1
        id="thanks-heading"
        className="text-3xl font-semibold tracking-tight md:text-4xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Thank you{customer?.firstName ? `, ${customer.firstName}` : ''}.
      </h1>
      <p className="text-base text-[var(--brand-muted)]">
        Your order is in. A confirmation email is on the way to{' '}
        <strong className="text-[var(--brand-ink)]">{customer?.email ?? 'your address'}</strong>.
        Reference: <code className="font-mono text-xs">{order.orderNumber}</code>.
      </p>

      <div className="rounded-[var(--radius)] border border-[var(--brand-border)]">
        <ul className="divide-y divide-[var(--brand-border)]">
          {order.lines.map((l, i) => (
            <li key={i} className="flex justify-between p-4 text-sm">
              <span>
                {l.quantity}× {l.productName ?? 'Product'}
                {l.colour ? ` (${l.colour})` : ''}
              </span>
              <span>£{l.lineTotal}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-between border-t border-[var(--brand-border)] p-4 text-sm">
          <span>Shipping</span>
          <span>£{order.totals.deliveryCharge}</span>
        </div>
        <div className="flex justify-between border-t border-[var(--brand-border)] p-4 text-base font-medium">
          <span>Total</span>
          <span>£{order.totals.grandTotal}</span>
        </div>
      </div>

      {order.deliveryAddress && (
        <div className="rounded-[var(--radius)] border border-[var(--brand-border)] p-4 text-sm">
          <p className="font-medium">Shipping to</p>
          <p className="text-[var(--brand-muted)]">
            {order.deliveryAddress.line1}, {order.deliveryAddress.city}{' '}
            {order.deliveryAddress.postCode}
          </p>
        </div>
      )}

      <p>
        <Link
          href="/shop"
          className="inline-block rounded-[var(--radius)] border border-[var(--brand-border)] px-4 py-2 text-sm hover:border-[var(--brand-ink)]"
        >
          Browse the rest of the range
        </Link>
      </p>
    </section>
  );
}
