'use client';

/**
 * Add-to-cart button used by the swatch picker and the standalone product
 * page. POST /api/cart with the productId; on success, fires a
 * `cart:updated` window event so the header counter refreshes, and bumps
 * a transient "Added" state for ~2s.
 */
import * as React from 'react';
import { useMutation } from '@tanstack/react-query';

interface AddArgs {
  productId: string;
  quantity?: number;
}

async function addToCart({ productId, quantity = 1 }: AddArgs): Promise<void> {
  const res = await fetch('/api/cart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId, quantity }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Add failed (${res.status})`);
  }
}

export interface AddToCartButtonProps {
  productId: string;
  /** When false the button shows "Notify me" and is disabled. */
  inStock: boolean;
  /** Optional override label (e.g. "Add to cart"). */
  label?: string;
}

export function AddToCartButton({ productId, inStock, label = 'Add to cart' }: AddToCartButtonProps) {
  const [justAdded, setJustAdded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: addToCart,
    onSuccess: () => {
      setError(null);
      setJustAdded(true);
      window.dispatchEvent(new Event('cart:updated'));
      setTimeout(() => setJustAdded(false), 2_000);
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Add to cart failed');
    },
  });

  if (!inStock) {
    return (
      <button
        type="button"
        disabled
        className="w-full rounded-[var(--radius)] bg-[var(--brand-ink)] px-6 py-3 text-base font-medium text-[var(--brand-paper)] opacity-60"
      >
        Notify me
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => mutation.mutate({ productId })}
        disabled={mutation.isPending}
        aria-live="polite"
        className="w-full rounded-[var(--radius)] bg-[var(--brand-ink)] px-6 py-3 text-base font-medium text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {mutation.isPending ? 'Adding…' : justAdded ? 'Added ✓' : label}
      </button>
      {error && (
        <p role="alert" className="text-xs text-[color:red]">
          {error}
        </p>
      )}
    </div>
  );
}
