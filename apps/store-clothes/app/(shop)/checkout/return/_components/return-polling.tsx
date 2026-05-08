'use client';

/**
 * Client-side poller for /api/checkout/status.
 *
 *   - Polls every 1.5s for up to 60s (40 attempts).
 *   - On COMMITTED, navigates to /confirmation/[orderId].
 *   - On FAILED, surfaces the reason + a retry CTA back to /checkout.
 *   - The status route does its own Mollie-fallback at >30s, so the
 *     poller doesn't need to coordinate that itself.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface StatusView {
  checkoutId: string;
  status: 'OPEN' | 'RESERVED' | 'PAYING' | 'COMMITTED' | 'FAILED' | 'ABANDONED';
  smmtaOrderId: string | null;
  mollieStatus: string | null;
  failureReason: string | null;
}

const POLL_INTERVAL_MS = 1_500;
const MAX_ATTEMPTS = 40; // 60s

async function fetchStatus(cid: string): Promise<StatusView | { error: string }> {
  const res = await fetch(`/api/checkout/status?cid=${encodeURIComponent(cid)}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { error: body.error ?? `Request failed (${res.status})` };
  }
  return (await res.json()) as StatusView;
}

export function ReturnPolling({ checkoutId }: { checkoutId: string }) {
  const router = useRouter();
  const [last, setLast] = React.useState<StatusView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [exhausted, setExhausted] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      const result = await fetchStatus(checkoutId);
      if (cancelled) return;
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setLast(result);
      if (result.status === 'COMMITTED' && result.smmtaOrderId) {
        clearInterval(timer);
        router.replace(`/confirmation/${result.smmtaOrderId}`);
        return;
      }
      if (result.status === 'FAILED') {
        clearInterval(timer);
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(timer);
        setExhausted(true);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [checkoutId, router]);

  if (last?.status === 'FAILED') {
    return (
      <div className="space-y-3 rounded-[var(--radius)] border border-[var(--brand-border)] p-4">
        <p className="font-medium">Payment didn&rsquo;t complete.</p>
        <p className="text-sm text-[var(--brand-muted)]">
          {last.failureReason ?? 'Mollie reported the payment as ' + (last.mollieStatus ?? 'failed') + '.'}
        </p>
        <Link
          href="/checkout"
          className="inline-block rounded-[var(--radius)] bg-[var(--brand-ink)] px-4 py-2 text-sm font-medium text-[var(--brand-paper)]"
        >
          Try again
        </Link>
      </div>
    );
  }

  if (exhausted) {
    return (
      <div className="space-y-2 rounded-[var(--radius)] border border-[var(--brand-border)] p-4">
        <p className="font-medium">Still waiting on Mollie&hellip;</p>
        <p className="text-sm text-[var(--brand-muted)]">
          The payment provider hasn&rsquo;t confirmed your order in time. Check your email for the
          confirmation; if it doesn&rsquo;t arrive in 5 minutes, contact{' '}
          <a href="mailto:orders@filament.shop">orders@filament.shop</a> with reference{' '}
          <code className="font-mono text-xs">{checkoutId.slice(0, 8)}</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm text-[var(--brand-muted)]" data-testid="return-polling">
      <p>
        Status: <strong>{last?.status ?? 'checking…'}</strong>
        {last?.mollieStatus && <> (Mollie: {last.mollieStatus})</>}
      </p>
      {error && (
        <p role="alert" className="text-[color:red]">
          {error}
        </p>
      )}
    </div>
  );
}
