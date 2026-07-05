'use client';

/** Register-interest email mini-form for a coming-soon product (SPEC F8). */
import { useState } from 'react';

export function RegisterInterestForm({ prospectiveId }: { prospectiveId: string }) {
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
        body: JSON.stringify({ email, prospectiveId }),
      });
      setState(res.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'done') {
    return <p className="text-sm" style={{ color: 'var(--brand-accent)' }}>Thanks — we&apos;ll let you know.</p>;
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="your@email.com"
        className="flex-1 border border-[var(--brand-border)] bg-white px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={state === 'sending'}
        className="bg-[var(--brand-accent)] px-4 py-2 text-sm font-semibold text-white"
      >
        {state === 'sending' ? '…' : 'Register interest'}
      </button>
      {state === 'error' && <span className="self-center text-xs text-red-600">Try again</span>}
    </form>
  );
}
