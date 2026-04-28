/**
 * /checkout/return?cid=… — landed here from Mollie's redirect.
 *
 * Server component renders the polling shell + a robots:noindex; the
 * client island polls /api/checkout/status and either redirects to
 * /confirmation/[orderId] (on COMMITTED) or surfaces the failure.
 *
 * The status endpoint itself does the safety-net Mollie fetch when
 * appropriate, so we don't duplicate that logic here.
 */
import type { Metadata } from 'next';
import { ReturnPolling } from './_components/return-polling';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Confirming payment',
  robots: { index: false, follow: false },
};

interface SearchParams {
  cid?: string;
}

export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { cid } = await searchParams;
  if (!cid) {
    return (
      <section className="space-y-3">
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Confirming payment
        </h1>
        <p className="text-[var(--brand-muted)]">
          We can&rsquo;t find a checkout reference. If you&rsquo;ve just paid, your confirmation
          email is on its way; if not, head back to the basket and try again.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-live="polite">
      <h1
        className="text-3xl font-semibold tracking-tight"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Confirming your payment
      </h1>
      <p className="text-[var(--brand-muted)]">
        Just a moment — we&rsquo;re finalising your order with the workshop.
      </p>
      <ReturnPolling checkoutId={cid} />
    </section>
  );
}
