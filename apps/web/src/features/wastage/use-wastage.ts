import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { pwaQueue } from '@/features/pwa/use-pwa-jobs';
import { submitOrQueue, type SubmitResult } from '@/lib/offline-submit';
import type { QueuedAction } from '@/lib/offline-queue';

/**
 * Standalone wastage (Sept-2026 user testing, item 7).
 *
 * "take this wastage function out of the end of bake form and create a separate
 *  Wastage form linked to by a new main menu item on the PWA where any items
 *  from stock can be marked as wasted."
 */

export interface WastageEvent {
  id: string;
  siteId: string;
  productId: string;
  productName: string;
  qty: string;
  stockUom: string;
  reason: string;
  note: string | null;
  recordedBy: string | null;
  sessionId: string | null;
  bake: string | null;
  occurredAt: string;
}

/** The suggested reasons. Free text is still accepted — this is a shortcut. */
export const WASTAGE_REASONS = [
  'Spillage',
  'Burnt',
  'Dropped',
  'Over-portioned',
  'Off / expired',
  'Damaged in delivery',
] as const;

export interface RecordWastageDraft {
  siteId: string;
  productId: string;
  productName: string;
  qty: number;
  reason: string;
  note?: string | null;
  recordedBy?: string | null;
  /** Optional bake link — most waste is not part of a bake. */
  sessionId?: string | null;
}

export const wastageKeys = {
  all: ['wastage'] as const,
  list: (siteId: string | null) => ['wastage', 'list', siteId ?? 'none'] as const,
};

export function useRecentWastage(siteId: string | null) {
  return useQuery<WastageEvent[]>({
    queryKey: wastageKeys.list(siteId),
    queryFn: () => apiFetch<WastageEvent[]>('/wastage', { searchParams: { siteId: siteId! } }),
    enabled: !!siteId,
  });
}

/**
 * Record wasted stock — offline-tolerant, like every other venue job.
 *
 * The `clientKey` doubles as the queue's idempotency key and the server's
 * replay guard, so a retry after a dropped connection finds its own row rather
 * than wasting the stock a second time.
 */
export function useRecordWastage() {
  const qc = useQueryClient();
  return useMutation<SubmitResult, Error, RecordWastageDraft>({
    mutationFn: (input) => {
      const action: QueuedAction = {
        idempotencyKey: `wastage:${crypto.randomUUID()}`,
        endpoint: '/wastage',
        method: 'POST',
        body: {
          siteId: input.siteId,
          productId: input.productId,
          qty: input.qty,
          reason: input.reason,
          note: input.note ?? null,
          recordedBy: input.recordedBy ?? null,
          sessionId: input.sessionId ?? null,
          clientKey: '',
        },
        enqueuedAt: Date.now(),
        label: `Wastage — ${input.qty} ${input.productName}`,
      };
      (action.body as { clientKey: string }).clientKey = action.idempotencyKey;
      return submitOrQueue(pwaQueue, action, (a) =>
        apiFetch(a.endpoint, { method: a.method, body: a.body }),
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: wastageKeys.all }),
  });
}
