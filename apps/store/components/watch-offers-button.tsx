'use client';

/** "Watch for offers" contextual interest button for an in-stock SKU (SPEC F8).
 *  Reveals an email mini-form; registers an 'offers' interest flag. */
import { useState } from 'react';

export function WatchOffersButton({ sku }: { sku: string }) {
  const [openForm, setOpenForm] = useState(false);
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || state === 'sending') return;
    setState('sending');
    try {
      const res = await fetch('/api/interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, sku, flagType: 'offers' }),
      });
      setState(res.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'done') {
    return <p className="mt-3 text-sm" style={{ color: 'var(--brand-accent)' }}>We&apos;ll email you about offers on this.</p>;
  }

  if (!openForm) {
    return (
      <button
        onClick={() => setOpenForm(true)}
        className="mt-3 border border-[var(--brand-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--brand-accent-ice)]"
      >
        Watch for offers
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 flex gap-2">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="your@email.com"
        className="flex-1 border border-[var(--brand-border)] bg-white px-3 py-1.5 text-sm"
      />
      <button type="submit" disabled={state === 'sending'} className="bg-[var(--brand-accent)] px-3 py-1.5 text-xs font-semibold text-white">
        {state === 'sending' ? '…' : 'Watch'}
      </button>
    </form>
  );
}
