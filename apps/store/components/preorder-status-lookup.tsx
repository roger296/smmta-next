'use client';

import { useState } from 'react';

const gbp = (pence: number) => `£${(pence / 100).toFixed(2)}`;

const STATUS_COPY: Record<string, string> = {
  awaiting_payment: 'Awaiting your bank transfer.',
  paid: 'Paid — thank you. We’ll dispatch when the shipment arrives.',
  lapsed: 'This pre-order lapsed (payment not received in time).',
  cancelled: 'Cancelled.',
  refund_pending: 'Cancelled — a refund is being processed.',
  refunded: 'Refunded.',
};

interface Result {
  status: string;
  totalPence: number;
  paymentReference: string;
  paymentMethod: string;
  createdAt: string;
}

export function PreorderStatusLookup() {
  const [reference, setReference] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'notfound' | 'error'>('idle');
  const [result, setResult] = useState<Result | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reference || !email || state === 'loading') return;
    setState('loading');
    setResult(null);
    try {
      const res = await fetch('/api/preorder/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: reference.trim(), email: email.trim() }),
      });
      if (res.status === 404) {
        setState('notfound');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      setResult((await res.json()) as Result);
      setState('idle');
    } catch {
      setState('error');
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3 border border-[var(--brand-border)] p-5">
        <div>
          <label htmlFor="ref" className="text-sm">Reference</label>
          <input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="PO-XXXXXXXX" className="mt-1 w-full border border-[var(--brand-border)] bg-white px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="lemail" className="text-sm">Email</label>
          <input id="lemail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="mt-1 w-full border border-[var(--brand-border)] bg-white px-3 py-2 text-sm" />
        </div>
        <button type="submit" disabled={state === 'loading'} className="w-full bg-[var(--brand-accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {state === 'loading' ? 'Checking…' : 'Check status'}
        </button>
        {state === 'notfound' && <p className="text-sm text-red-600">No pre-order found for that reference + email.</p>}
        {state === 'error' && <p className="text-sm text-red-600">Something went wrong. Please try again.</p>}
      </form>

      {result && (
        <div className="border border-[var(--brand-border)] p-5">
          <p className="text-sm font-semibold">{result.paymentReference}</p>
          <p className="mt-1 text-sm">{STATUS_COPY[result.status] ?? result.status}</p>
          <p className="mt-2 text-sm text-[var(--brand-muted)]">Total {gbp(result.totalPence)}</p>
          {result.status === 'awaiting_payment' && (
            <p className="mt-3 text-xs text-[var(--brand-muted)]">
              Pay by bank transfer using the reference above. You can cancel any time before dispatch for a full refund.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
