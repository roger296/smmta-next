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
      <section aria-labelledby="cart-heading" className="max-w-xl space-y-4">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          Empty basket
        </p>
        <h1
          id="cart-heading"
          className="text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Nothing here yet.
        </h1>
        <p className="text-base text-[var(--brand-muted)]">
          Pick a material, pick a colour — we&rsquo;ll ship it from the UK warehouse the
          same day on orders before 2pm.
        </p>
        <Link
          href="/shop"
          className="mt-2 inline-block bg-[var(--brand-ink)] px-7 py-4 text-sm font-semibold uppercase tracking-wider text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)]"
        >
          Browse the range
        </Link>
      </section>
    );
  }

  return (
    <section aria-labelledby="cart-heading" className="space-y-8">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          Your basket
        </p>
        <h1
          id="cart-heading"
          className="text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {cart.itemCount} item{cart.itemCount === 1 ? '' : 's'} ready.
        </h1>
      </header>

      <div className="grid gap-10 lg:grid-cols-[2fr_1fr]">
        <ul
          className="divide-y divide-[var(--brand-border)] border-y border-[var(--brand-border)]"
          data-testid="cart-lines"
        >
          {cart.lines.map((line) => (
            <li key={line.id} className="flex items-start gap-5 py-5">
              <div className="h-24 w-24 flex-shrink-0 overflow-hidden border border-[var(--brand-border)] bg-[var(--brand-bone)]">
                {line.display.heroImageUrl ? (
                  <Image
                    src={line.display.heroImageUrl}
                    alt={line.display.name ?? 'Product image'}
                    width={120}
                    height={120}
                    sizes="96px"
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </div>
              <div className="flex-1 space-y-1">
                <p className="font-semibold leading-snug">
                  {line.display.name ?? 'Unavailable product'}
                  {line.display.colour ? (
                    <span className="text-[var(--brand-accent)]"> — {line.display.colour}</span>
                  ) : null}
                </p>
                <p className="text-sm text-[var(--brand-muted)]">£{line.pricePerUnitGbp} each</p>
                {line.display.slug && (
                  <Link
                    href={`/shop/p/${line.display.slug}`}
                    className="text-xs uppercase tracking-wider text-[var(--brand-muted)] transition-colors hover:text-[var(--brand-ink)]"
                  >
                    View product →
                  </Link>
                )}
              </div>
              <div className="flex flex-col items-end gap-3">
                <p className="font-semibold">£{line.lineTotalGbp}</p>
                <CartLineControls itemId={line.id} initialQuantity={line.quantity} />
              </div>
            </li>
          ))}
        </ul>

        <aside
          className="space-y-4 self-start border border-[var(--brand-border)] bg-[var(--brand-bone)] p-6"
          data-testid="cart-totals"
        >
          <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]">
            Order summary
          </h2>
          <div className="flex items-center justify-between border-y border-[var(--brand-border)] py-4">
            <p className="text-sm text-[var(--brand-muted)]">
              Subtotal · {cart.itemCount} item{cart.itemCount === 1 ? '' : 's'}
            </p>
            <p
              className="text-2xl font-bold"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              £{cart.subtotalGbp}
            </p>
          </div>
          <p className="text-xs text-[var(--brand-muted)]">
            Shipping calculated at checkout. UK orders ship same day before 2pm.
          </p>
          <Link
            href="/checkout"
            className="block w-full bg-[var(--brand-ink)] px-6 py-4 text-center text-sm font-semibold uppercase tracking-wider text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)]"
          >
            Proceed to checkout
          </Link>
        </aside>
      </div>
    </section>
  );
}
