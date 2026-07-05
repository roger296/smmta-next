'use client';

/**
 * Pre-order checkout (SPEC §16.2, §16.2a). One unticked CCR confirmation
 * capturing the estimated date + estimate status + the bank-payment rule + the
 * cancel-before-dispatch right. £-only. On success, shows the bank-transfer
 * reference.
 */
import { useState } from 'react';

const gbp = (pence: number) => `£${(pence / 100).toFixed(2)}`;

export function PreorderCheckout({
  slug,
  sku,
  poolRef,
  etaLabel,
  unitPricePence,
  savingsVsBasePence,
}: {
  slug: string;
  sku: string;
  poolRef: string;
  etaLabel: string;
  unitPricePence: number;
  savingsVsBasePence: number;
}) {
  const [email, setEmail] = useState('');
  const [qty, setQty] = useState(1);
  const [ccr, setCcr] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [totalPence, setTotalPence] = useState<number | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ccr || !email || state === 'sending') return;
    setState('sending');
    setError(null);
    try {
      const res = await fetch('/api/preorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, sku, poolRef, qty, ccrAccepted: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { paymentReference?: string; totalPence?: number; error?: string };
      if (!res.ok || !body.paymentReference) {
        setError(res.status === 409 ? 'This item can no longer be pre-ordered.' : 'Could not place your pre-order.');
        setState('error');
        return;
      }
      setRef(body.paymentReference);
      setTotalPence(body.totalPence ?? unitPricePence * qty);
    } catch {
      setError('Something went wrong. Please try again.');
      setState('error');
    }
  }

  if (ref) {
    return (
      <div className="border border-[var(--brand-border)] p-5">
        <h2 className="text-lg font-semibold">Pre-order placed</h2>
        <p className="mt-2 text-sm">
          Please pay {gbp(totalPence ?? 0)} by bank transfer using reference <strong>{ref}</strong>. We&apos;ll email you
          when it&apos;s received. You can cancel any time before dispatch for a full refund.
        </p>
        <p className="mt-3 text-xs">
          <a href="/preorder-status" className="underline">
            Check your pre-order status
          </a>
        </p>
      </div>
    );
  }

  const lineTotal = unitPricePence * qty;

  return (
    <form onSubmit={submit} className="space-y-5 border border-[var(--brand-border)] p-5">
      <div>
        <p className="text-sm text-[var(--brand-muted)]">Pre-order · due around {etaLabel} (estimate)</p>
        <p className="mt-1 text-lg font-semibold">
          {gbp(unitPricePence)} <span className="text-sm font-normal text-[var(--brand-muted)]">per roll</span>
        </p>
        {savingsVsBasePence > 0 && (
          <p className="text-sm" style={{ color: 'var(--brand-accent)' }}>
            Save {gbp(savingsVsBasePence)} a roll
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <label htmlFor="qty" className="text-sm">
          Quantity
        </label>
        <input
          id="qty"
          type="number"
          min={1}
          max={999}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          className="w-20 border border-[var(--brand-border)] px-2 py-1 text-sm"
        />
        <span className="ml-auto text-sm font-medium">Total {gbp(lineTotal)}</span>
      </div>

      <div>
        <label htmlFor="email" className="text-sm">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="mt-1 w-full border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
        />
      </div>

      {/* §16.2a honest framing. */}
      <p className="bg-[var(--brand-paper)] p-3 text-xs leading-relaxed text-[var(--brand-ink)]">
        When you pre-order, you pay up front for stock that hasn&apos;t arrived yet. That helps our cash flow — your
        money helps fund the shipment — and that&apos;s exactly why we give you a bigger saving the earlier you commit.
        Paying by bank transfer also means no card fees, and that saving goes into your discount too. In return you&apos;re
        protected: cancel any time before dispatch for a full refund, and if the shipment is lost you get every penny back
        automatically.
      </p>

      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={ccr} onChange={(e) => setCcr(e.target.checked)} className="mt-0.5" />
        <span>
          I understand the estimated arrival is around <strong>{etaLabel}</strong> (an estimate, not a fixed date), that
          this order is paid by bank transfer, and that I can cancel any time before dispatch for a full refund.
        </span>
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={!ccr || state === 'sending'}
        className="w-full bg-[var(--brand-accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {state === 'sending' ? 'Placing…' : 'Place pre-order'}
      </button>
      <p className="text-center text-xs text-[var(--brand-muted)]">
        <a href={`/shop/${encodeURIComponent(slug)}`} className="underline">
          Back to product
        </a>
      </p>
    </form>
  );
}
