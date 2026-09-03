'use client';

/**
 * Header cart link with a live item-count badge. Reads /api/cart on mount
 * and re-reads after `cart:updated` window events fired by the add-to-cart
 * buttons. Lightweight on purpose — the full cart drawer / cart page does
 * the heavy work.
 */
import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

interface CartView {
  itemCount: number;
}

async function fetchCart(): Promise<CartView> {
  const res = await fetch('/api/cart', { cache: 'no-store' });
  if (!res.ok) return { itemCount: 0 };
  return (await res.json()) as CartView;
}

export function CartHeaderLink() {
  const { data, refetch } = useQuery({
    queryKey: ['cart'],
    queryFn: fetchCart,
    staleTime: 0,
  });

  React.useEffect(() => {
    const onUpdate = () => {
      void refetch();
    };
    window.addEventListener('cart:updated', onUpdate);
    return () => window.removeEventListener('cart:updated', onUpdate);
  }, [refetch]);

  const count = data?.itemCount ?? 0;
  return (
    <Link
      href="/cart"
      className="inline-flex min-h-11 items-center gap-2 transition-colors hover:text-[var(--brand-accent)]"
      aria-label={count === 0 ? 'Cart, empty' : `Cart, ${count} item${count === 1 ? '' : 's'}`}
    >
      Cart
      {count > 0 && (
        <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center bg-[var(--brand-accent)] px-1.5 text-xs font-semibold text-[var(--brand-paper)]">
          {count}
        </span>
      )}
    </Link>
  );
}
