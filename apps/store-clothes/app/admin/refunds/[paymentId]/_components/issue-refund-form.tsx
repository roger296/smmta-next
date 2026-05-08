'use client';

/**
 * Issue-refund form. Client-side because it has to handle the API
 * response inline (success / partial-refund-too-large / Mollie API
 * down) without a full reload, and it has to refresh the RSC tree
 * after a successful refund so the history list updates.
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface Props {
  paymentId: string;
  /** Decimal-string remaining refundable amount, e.g. "12.45". */
  remainingGbp: string;
  currency: string;
}

interface ApiSuccess {
  refundId: string;
  status: string;
  amountGbp: string;
}
interface ApiError {
  error: string;
  code?: string;
}

export function IssueRefundForm({ paymentId, remainingGbp, currency }: Props) {
  const router = useRouter();
  const [amount, setAmount] = useState(remainingGbp);
  const [reason, setReason] = useState('');
  const [creditNoteId, setCreditNoteId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ApiSuccess | null>(null);
  const [pending, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmed = amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
      setError('Amount must be a decimal like "12.45".');
      return;
    }

    const body = {
      paymentId,
      amountGbp: trimmed,
      reason: reason.trim() ? reason.trim() : undefined,
      smmtaCreditNoteId: creditNoteId.trim() ? creditNoteId.trim() : undefined,
    };

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/refunds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => ({}))) as ApiSuccess | ApiError;
        if (!res.ok) {
          setError(
            'error' in json && typeof json.error === 'string'
              ? json.error
              : 'Refund failed.',
          );
          return;
        }
        setSuccess(json as ApiSuccess);
        // Refresh the page so the refund history + remaining amount re-render.
        router.refresh();
      } catch {
        setError('Network error. Please retry.');
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-[var(--radius)] border border-[var(--brand-border)] p-4"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">
            Amount ({currency}) — max £{remainingGbp}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="w-full rounded-[var(--radius)] border border-[var(--brand-border)] px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">SMMTA credit note id (optional)</span>
          <input
            type="text"
            value={creditNoteId}
            onChange={(e) => setCreditNoteId(e.target.value)}
            placeholder="UUID from /apps/web credit note"
            className="w-full rounded-[var(--radius)] border border-[var(--brand-border)] px-3 py-2 font-mono text-xs"
          />
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Reason (optional, sent to Mollie)</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          className="w-full rounded-[var(--radius)] border border-[var(--brand-border)] px-3 py-2"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius)] bg-[var(--brand-ink)] px-4 py-2 text-sm font-medium text-[var(--brand-paper)] disabled:opacity-50"
        >
          {pending ? 'Issuing…' : 'Issue refund'}
        </button>
        {success ? (
          <p
            className="text-sm text-emerald-800"
            role="status"
            aria-live="polite"
          >
            Refund <code className="text-xs">{success.refundId}</code> issued
            for £{success.amountGbp} ({success.status}).
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
