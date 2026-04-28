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
      className="inline-flex items-center gap-2 hover:underline"
      aria-label={count === 0 ? 'Cart, empty' : `Cart, ${count} item${count === 1 ? '' : 's'}`}
    >
      Cart
      {count > 0 && (
        <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-[var(--brand-ink)] px-1.5 text-xs font-medium text-[var(--brand-paper)]">
          {count}
        </span>
      )}
    </Link>
  );
}
