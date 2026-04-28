/**
 * Checkout (`/checkout`). RSC reads the cart for the totals breakdown;
 * client island renders the form, posts to /api/checkout/start, and
 * redirects to Mollie. Robots: noindex.
 *
 * Shipping is a single fixed-rate option for v1 (STORE_DEFAULT_SHIPPING_GBP).
 * Real shipping zones / rules are a follow-up per the architecture doc.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { readCartIdFromCookie } from '@/lib/cookies';
import { getOrCreateCart } from '@/lib/cart';
import { getEnv } from '@/lib/env';
import { CheckoutForm } from './_components/checkout-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
  alternates: { canonical: '/checkout' },
};

export default async function CheckoutPage() {
  const env = getEnv();
  const cartId = await readCartIdFromCookie();
  const cart = await getOrCreateCart(cartId);

  if (cart.lines.length === 0) {
    redirect('/cart');
  }

  const shipping = env.STORE_DEFAULT_SHIPPING_GBP;
  const shippingPence = Math.round(Number.parseFloat(shipping) * 100);
  const subtotalPence = Math.round(Number.parseFloat(cart.subtotalGbp) * 100);
  const grandTotal = ((subtotalPence + shippingPence) / 100).toFixed(2);

  return (
    <section aria-labelledby="checkout-heading" className="space-y-6">
      <h1
        id="checkout-heading"
        className="text-3xl font-semibold tracking-tight md:text-4xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Checkout
      </h1>

      <div className="grid gap-8 md:grid-cols-[1fr_320px]">
        <CheckoutForm />

        <aside
          aria-labelledby="totals-heading"
          className="h-fit space-y-3 rounded-[var(--radius)] border border-[var(--brand-border)] p-4"
        >
          <h2 id="totals-heading" className="text-base font-medium">
            Order summary
          </h2>
          <ul className="space-y-1 text-sm">
            {cart.lines.map((l) => (
              <li key={l.id} className="flex justify-between gap-2">
                <span className="line-clamp-1">
                  {l.quantity}× {l.display.name ?? 'Product'}
                  {l.display.colour ? ` (${l.display.colour})` : ''}
                </span>
                <span>£{l.lineTotalGbp}</span>
              </li>
            ))}
          </ul>
          <hr className="border-[var(--brand-border)]" />
          <p className="flex justify-between text-sm">
            <span>Subtotal</span>
            <span>£{cart.subtotalGbp}</span>
          </p>
          <p className="flex justify-between text-sm">
            <span>Shipping</span>
            <span>£{shipping}</span>
          </p>
          <hr className="border-[var(--brand-border)]" />
          <p className="flex justify-between text-base font-medium">
            <span>Total</span>
            <span>£{grandTotal}</span>
          </p>
          <p className="text-xs text-[var(--brand-muted)]">
            <Link href="/cart" className="hover:underline">
              Edit basket
            </Link>
          </p>
        </aside>
      </div>
    </section>
  );
}
