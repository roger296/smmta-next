'use client';

/**
 * Add-to-cart button used by the swatch picker and the standalone product
 * page. POST /api/cart with the productId; on success, fires a
 * `cart:updated` window event so the header counter refreshes, and bumps
 * a transient "Added" state for ~2s.
 *
 * When `inStock` is false we render a "Notify me when this item is back
 * in stock" CTA that opens an inline form (email + opt-in newsletter
 * checkbox, default ticked) and POSTs to /api/notify-me.
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

interface NotifyArgs {
  productId: string;
  email: string;
  subscribeToNewsletter: boolean;
}

async function postNotifyMe(args: NotifyArgs): Promise<void> {
  const res = await fetch('/api/notify-me', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Subscribe failed (${res.status})`);
  }
}

export interface AddToCartButtonProps {
  productId: string;
  /** When false the control switches to the "Notify me" flow. */
  inStock: boolean;
  /** Optional override label (e.g. "Add to cart"). */
  label?: string;
  /** Show the quantity stepper. Off in compact contexts (the sticky
   *  mobile bar), on for the main product-page CTA. */
  showQuantity?: boolean;
  /** Trade-break hint shown under the stepper, e.g. "10+ spools:
   *  discount applied at checkout". */
  bulkHint?: string;
}

export function AddToCartButton({
  productId,
  inStock,
  label = 'Add to cart',
  showQuantity = false,
  bulkHint,
}: AddToCartButtonProps) {
  if (!inStock) {
    return <NotifyMeForm productId={productId} />;
  }

  return (
    <AddToCartActiveButton
      productId={productId}
      label={label}
      showQuantity={showQuantity}
      bulkHint={bulkHint}
    />
  );
}

/** Cart maximum per line — matches the server-side validation. */
const MAX_QTY = 99;

function AddToCartActiveButton({
  productId,
  label,
  showQuantity,
  bulkHint,
}: {
  productId: string;
  label: string;
  showQuantity: boolean;
  bulkHint?: string;
}) {
  const [justAdded, setJustAdded] = React.useState(false);
  const [quantity, setQuantity] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: addToCart,
    onSuccess: () => {
      setError(null);
      setJustAdded(true);
      window.dispatchEvent(new Event('cart:updated'));
      setTimeout(() => setJustAdded(false), 6_000);
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Add to cart failed');
    },
  });

  return (
    <div className="space-y-3">
      {showQuantity && (
        <div className="flex items-center gap-3">
          <span id="qty-label" className="text-sm text-[var(--brand-muted)]">
            Quantity
          </span>
          <div className="flex items-center border border-[var(--brand-border)]">
            <button
              type="button"
              aria-label="Decrease quantity"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={quantity <= 1}
              className="h-11 w-11 text-lg disabled:opacity-40"
            >
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_QTY}
              value={quantity}
              aria-labelledby="qty-label"
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setQuantity(Math.min(MAX_QTY, Math.max(1, Math.trunc(n))));
              }}
              className="h-11 w-14 border-x border-[var(--brand-border)] bg-transparent text-center text-sm"
            />
            <button
              type="button"
              aria-label="Increase quantity"
              onClick={() => setQuantity((q) => Math.min(MAX_QTY, q + 1))}
              disabled={quantity >= MAX_QTY}
              className="h-11 w-11 text-lg disabled:opacity-40"
            >
              +
            </button>
          </div>
        </div>
      )}

      {/* The trade break was advertised only in the FAQ, which is the
          wrong place for it — surfaced here it's at the point of
          decision, next to the control that acts on it. */}
      {showQuantity && bulkHint && (
        <p className="text-xs text-[var(--brand-muted)]">{bulkHint}</p>
      )}

      <button
        type="button"
        onClick={() => mutation.mutate({ productId, quantity })}
        disabled={mutation.isPending}
        className="w-full bg-[var(--brand-ink)] px-6 py-4 text-sm font-semibold uppercase tracking-wider text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {mutation.isPending ? 'Adding…' : label}
      </button>

      {/*
        Bug 11: the only confirmation used to be the header cart badge,
        which on a product page sits well above the fold and off-screen —
        so the natural next move was to press the button again. This
        confirmation sits directly under the control that caused it,
        carries a link onward, and is announced to screen readers.
      */}
      {justAdded && !error && (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-3 border border-[var(--brand-border)] bg-[var(--brand-bone)] px-3 py-2 text-sm"
        >
          <span>
            Added{quantity > 1 ? ` × ${quantity}` : ''} to your basket
          </span>
          <a href="/cart" className="font-semibold text-[var(--brand-accent)] hover:underline">
            View basket →
          </a>
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs font-medium text-[#c43333]">
          {error}
        </p>
      )}
    </div>
  );
}

function NotifyMeForm({ productId }: { productId: string }) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [subscribeToNewsletter, setSubscribeToNewsletter] = React.useState(true);
  const [submitted, setSubmitted] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: postNotifyMe,
    onSuccess: () => {
      setError(null);
      setSubmitted(true);
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not subscribe — please try again.');
    },
  });

  if (submitted) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="border border-[var(--brand-border)] bg-[var(--brand-bone)] px-6 py-4 text-sm font-medium text-[var(--brand-ink)]"
      >
        Thanks — we'll email you when it's back.
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full border border-[var(--brand-border)] bg-[var(--brand-bone)] px-6 py-4 text-sm font-semibold uppercase tracking-wider text-[var(--brand-ink)] transition-colors hover:border-[var(--brand-ink)]"
      >
        Notify me when this item is back in stock
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!email.trim()) {
          setError('Please enter your email.');
          return;
        }
        mutation.mutate({ productId, email: email.trim(), subscribeToNewsletter });
      }}
      noValidate
      className="space-y-3 border border-[var(--brand-border)] bg-[var(--brand-bone)] p-4"
    >
      <label className="block">
        <span className="block text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]">
          Email
        </span>
        <input
          type="email"
          name="notifyEmail"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          autoComplete="email"
          required
          className="mt-2 w-full border border-[var(--brand-border)] bg-[var(--brand-paper)] px-3 py-2 text-sm focus:border-[var(--brand-accent)] focus:outline-none"
        />
      </label>
      <label className="flex items-start gap-2 text-xs text-[var(--brand-muted)]">
        <input
          type="checkbox"
          checked={subscribeToNewsletter}
          onChange={(e) => setSubscribeToNewsletter(e.target.checked)}
          className="mt-0.5"
        />
        <span>Subscribe to occasional emails about new colours and offers.</span>
      </label>
      <button
        type="submit"
        disabled={mutation.isPending}
        className="w-full bg-[var(--brand-ink)] px-6 py-3 text-sm font-semibold uppercase tracking-wider text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {mutation.isPending ? 'Subscribing…' : 'Notify me'}
      </button>
      {error && (
        <p role="alert" className="text-xs font-medium text-[#c43333]">
          {error}
        </p>
      )}
    </form>
  );
}
