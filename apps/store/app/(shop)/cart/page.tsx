/**
 * Cart page (`/cart`). Server-rendered first; client controls take over for
 * quantity changes via TanStack Query. Robots: noindex (cart is private).
 */
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { getOrCreateCart } from '@/lib/cart';
import { readCartIdFromCookie } from '@/lib/cookies';
import { CartLineControls } from '@/components/cart-line-controls';

export const metadata: Metadata = {
  title: 'Your basket',
  // Cart is per-customer state; never indexable.
  robots: { index: false, follow: false },
  alternates: { canonical: '/cart' },
};

export const dynamic = 'force-dynamic';

export default async function CartPage() {
  const cartId = await readCartIdFromCookie();
  const cart = await getOrCreateCart(cartId);

  if (cart.lines.length === 0) {
    return (
      <section aria-labelledby="cart-heading" className="space-y-4">
        <h1
          id="cart-heading"
          className="text-3xl font-semibold tracking-tight md:text-4xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Your basket is empty
        </h1>
        <p className="text-base text-[var(--brand-muted)]">
          Pick a colour, pick a lamp, and we&rsquo;ll send it from the workshop.
        </p>
        <Link
          href="/shop"
          className="inline-block rounded-[var(--radius)] bg-[var(--brand-ink)] px-6 py-3 text-base font-medium text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)]"
        >
          Browse the range
        </Link>
      </section>
    );
  }

  return (
    <section aria-labelledby="cart-heading" className="space-y-6">
      <h1
        id="cart-heading"
        className="text-3xl font-semibold tracking-tight md:text-4xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Your basket
      </h1>

      <ul
        className="divide-y divide-[var(--brand-border)] rounded-[var(--radius)] border border-[var(--brand-border)]"
        data-testid="cart-lines"
      >
        {cart.lines.map((line) => (
          <li key={line.id} className="flex items-start gap-4 p-4">
            <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-[var(--radius)] bg-[var(--brand-border)]">
              {line.display.heroImageUrl ? (
                <Image
                  src={line.display.heroImageUrl}
                  alt={line.display.name ?? 'Product image'}
                  width={120}
                  height={120}
                  sizes="80px"
                  className="h-full w-full object-cover"
                />
              ) : null}
            </div>
            <div className="flex-1 space-y-1">
              <p className="font-medium">
                {line.display.name ?? 'Unavailable product'}
                {line.display.colour ? ` — ${line.display.colour}` : ''}
              </p>
              <p className="text-sm text-[var(--brand-muted)]">£{line.pricePerUnitGbp} each</p>
              {line.display.slug && (
                <Link
                  href={`/shop/p/${line.display.slug}`}
                  className="text-xs text-[var(--brand-muted)] hover:underline"
                >
                  View product
                </Link>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <p className="font-medium">£{line.lineTotalGbp}</p>
              <CartLineControls itemId={line.id} initialQuantity={line.quantity} />
            </div>
          </li>
        ))}
      </ul>

      <div
        className="flex flex-col items-end gap-3 rounded-[var(--radius)] border border-[var(--brand-border)] p-4"
        data-testid="cart-totals"
      >
        <p className="text-sm text-[var(--brand-muted)]">
          {cart.itemCount} item{cart.itemCount === 1 ? '' : 's'}
        </p>
        <p className="text-2xl font-medium">Subtotal £{cart.subtotalGbp}</p>
        <Link
          href="/checkout"
          className="rounded-[var(--radius)] bg-[var(--brand-ink)] px-6 py-3 text-base font-medium text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)]"
        >
          Proceed to checkout
        </Link>
        <p className="text-xs text-[var(--brand-muted)]">
          Checkout, shipping selection, and Mollie payment land in Prompt 10.
        </p>
      </div>
    </section>
  );
}
