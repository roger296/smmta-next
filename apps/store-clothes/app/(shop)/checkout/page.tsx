/**
 * Checkout (`/checkout`). RSC reads the cart for the totals breakdown;
 * client island renders the form, posts to /api/checkout/start, and
 * redirects to Mollie. Robots: noindex.
 *
 * Delivery is charged per parcel: each supplier sends its items in one parcel
 * with its own charge (`suppliers.delivery_charge_gbp`, or
 * STORE_DEFAULT_SHIPPING_GBP when a supplier has none). The summary shows the
 * quote from SMMTA; the reservation made on submit quotes it again and the
 * payment uses that. If the quote cannot be fetched, the flat rate is shown.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { readCartIdFromCookie } from '@/lib/cookies';
import { getOrCreateCart } from '@/lib/cart';
import { getEnv } from '@/lib/env';
import { getDeliveryQuote, type DeliveryQuote } from '@/lib/smmta';
import { deliveryNote, summariseParcels } from '@/lib/delivery';
import { BeginCheckoutEvent } from '@/components/begin-checkout-event';
import { CheckoutForm } from './_components/checkout-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
  alternates: { canonical: '/checkout' },
};

const toPence = (amount: string) => Math.round(Number.parseFloat(amount) * 100);

export default async function CheckoutPage() {
  const env = getEnv();
  const cartId = await readCartIdFromCookie();
  const cart = await getOrCreateCart(cartId);

  if (cart.lines.length === 0) {
    redirect('/cart');
  }

  const standardRate = env.STORE_DEFAULT_SHIPPING_GBP;
  let quote: DeliveryQuote | null = null;
  try {
    quote = await getDeliveryQuote(
      cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      standardRate,
    );
  } catch {
    quote = null;
  }
  const shipping = quote?.totalGbp ?? standardRate;
  const parcels = quote
    ? summariseParcels(
        quote,
        cart.lines.map((l) => ({ productId: l.productId, name: l.display.name ?? null })),
      )
    : [{ label: 'Delivery', chargeGbp: standardRate, itemNames: [] }];
  const grandTotal = ((toPence(cart.subtotalGbp) + toPence(shipping)) / 100).toFixed(2);

  return (
    <section aria-labelledby="checkout-heading" className="space-y-6">
      <BeginCheckoutEvent
        cart={{
          cartId: cart.cartId,
          currencyCode: cart.currencyCode,
          subtotalGbp: cart.subtotalGbp,
          lines: cart.lines.map((l) => ({
            productId: l.productId,
            slug: l.display.slug,
            name: l.display.name,
            colour: l.display.colour,
            quantity: l.quantity,
            pricePerUnitGbp: l.pricePerUnitGbp,
          })),
        }}
      />

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
          <ul className="space-y-2 text-sm" data-testid="delivery-charges">
            {parcels.map((p, i) => (
              <li key={i}>
                <p className="flex justify-between gap-2">
                  <span>{p.label}</span>
                  <span>£{p.chargeGbp}</span>
                </p>
                {parcels.length > 1 && p.itemNames.length > 0 && (
                  <p className="line-clamp-2 text-xs text-[var(--brand-muted)]">{p.itemNames.join(', ')}</p>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--brand-muted)]" data-testid="delivery-note">
            {deliveryNote(parcels.length)}
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
