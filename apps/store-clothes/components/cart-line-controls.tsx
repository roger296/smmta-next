'use client';

/**
 * Cart-line client controls — quantity stepper + remove button with
 * optimistic updates via TanStack Query. Server renders the cart page
 * once with the correct initial state; this component then takes over
 * for in-page mutations.
 */
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

interface SetQtyArgs {
  itemId: string;
  quantity: number;
}

async function setQty({ itemId, quantity }: SetQtyArgs): Promise<void> {
  const res = await fetch(`/api/cart/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Update failed (${res.status})`);
  }
}

interface Props {
  itemId: string;
  initialQuantity: number;
}

export function CartLineControls({ itemId, initialQuantity }: Props) {
  const qc = useQueryClient();
  const [quantity, setLocal] = React.useState(initialQuantity);
  const [error, setError] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: setQty,
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Update failed');
      setLocal(initialQuantity); // revert on failure
    },
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['cart'] });
      window.dispatchEvent(new Event('cart:updated'));
    },
  });

  const apply = (next: number) => {
    if (next < 0 || next > 99) return;
    setLocal(next);
    mutation.mutate({ itemId, quantity: next });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1" role="group" aria-label="Quantity">
        <button
          type="button"
          aria-label="Decrease quantity"
          onClick={() => apply(quantity - 1)}
          disabled={mutation.isPending || quantity <= 0}
          className="h-8 w-8 rounded-[var(--radius)] border border-[var(--brand-border)] disabled:opacity-50"
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={99}
          value={quantity}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next)) setLocal(next);
          }}
          onBlur={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next) && next !== initialQuantity) apply(next);
          }}
          aria-label="Quantity"
          className="h-8 w-12 rounded-[var(--radius)] border border-[var(--brand-border)] bg-transparent text-center"
        />
        <button
          type="button"
          aria-label="Increase quantity"
          onClick={() => apply(quantity + 1)}
          disabled={mutation.isPending || quantity >= 99}
          className="h-8 w-8 rounded-[var(--radius)] border border-[var(--brand-border)] disabled:opacity-50"
        >
          +
        </button>
      </div>
      <button
        type="button"
        onClick={() => apply(0)}
        disabled={mutation.isPending}
        className="text-xs text-[var(--brand-muted)] hover:text-[var(--brand-ink)] hover:underline"
      >
        Remove
      </button>
      {error && (
        <p role="alert" className="text-xs text-[color:red]">
          {error}
        </p>
      )}
    </div>
  );
}
