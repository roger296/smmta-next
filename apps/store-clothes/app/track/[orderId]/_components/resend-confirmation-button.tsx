'use client';

/**
 * Single button → POSTs `{ orderId }` to /api/track/resend-email and
 * shows a small status message inline. The handler is rate-limited
 * server-side; we just surface the response cleanly.
 */
import { useState, useTransition } from 'react';

interface Props {
  orderId: string;
}

interface ApiResponse {
  ok?: boolean;
  message?: string;
  error?: string;
  retryAfterSeconds?: number;
}

export function ResendConfirmationButton({ orderId }: Props) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/track/resend-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ orderId }),
        });
        const json = (await res.json().catch(() => ({}))) as ApiResponse;
        if (res.status === 429) {
          const wait = json.retryAfterSeconds ?? 60;
          setError(
            `Please wait ${Math.ceil(wait / 60)} more minute${
              wait > 60 ? 's' : ''
            } before trying again.`,
          );
          return;
        }
        if (!res.ok) {
          setError(json.error ?? 'Could not re-send. Please try later.');
          return;
        }
        setMessage(
          json.message ??
            'Done — check your inbox in a few minutes (also check spam).',
        );
      } catch {
        setError('Network error. Please retry.');
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="self-start rounded-[var(--radius)] border border-[var(--brand-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--brand-paper)] disabled:opacity-50"
      >
        {pending ? 'Sending…' : 'Re-send confirmation email'}
      </button>
      {message ? (
        <p className="text-sm text-emerald-800" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
