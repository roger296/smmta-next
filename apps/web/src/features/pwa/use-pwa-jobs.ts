import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import {
  OfflineQueue,
  LocalStorageQueueStorage,
  type QueuedAction,
} from '@/lib/offline-queue';
import { submitOrQueue, syncQueue, type SubmitResult } from '@/lib/offline-submit';

/** Shared offline queue for the iPad jobs. */
export const pwaQueue = new OfflineQueue(new LocalStorageQueueStorage());

const sendAction = (a: QueuedAction): Promise<void> =>
  apiFetch(a.endpoint, { method: a.method, body: a.body }).then(() => undefined);

export interface GoodsInLineDraft {
  productId: string;
  qtyPurchase: number;
  unitCost?: number;
  batchCode?: string;
  useBy?: string | null;
}

/** Goods-in submit — offline-tolerant (queues + replays with one idempotency key). */
export function useReceiveGoodsIn() {
  return useMutation<
    SubmitResult,
    Error,
    { siteId: string; reorderProposalId?: string; lines: GoodsInLineDraft[]; photoRefs?: unknown }
  >({
    mutationFn: (input) => {
      const action: QueuedAction = {
        idempotencyKey: `goods-in:${crypto.randomUUID()}`,
        endpoint: '/goods-in',
        method: 'POST',
        body: {
          siteId: input.siteId,
          reorderProposalId: input.reorderProposalId,
          idempotencyKey: '', // filled below from the action key
          lines: input.lines,
          photoRefs: input.photoRefs,
        },
        enqueuedAt: Date.now(),
        label: `Goods in — ${input.lines.length} line${input.lines.length === 1 ? '' : 's'}`,
      };
      (action.body as { idempotencyKey: string }).idempotencyKey = action.idempotencyKey;
      return submitOrQueue(pwaQueue, action, sendAction);
    },
  });
}

export function useOpenStockTake() {
  return useMutation<
    { data: { take: { id: string }; lines: unknown[] } },
    Error,
    { siteId: string; scope: string; scopeRef?: string }
  >({
    mutationFn: (input) =>
      apiFetch('/stock-takes', { method: 'POST', body: input }).then((d) => ({
        data: d as { take: { id: string }; lines: unknown[] },
      })),
  });
}

export function useRecordStockTakeCounts() {
  return useMutation<
    SubmitResult,
    Error,
    { stockTakeId: string; counts: Array<{ productId: string; countedQty: number }> }
  >({
    mutationFn: (input) => {
      const action: QueuedAction = {
        idempotencyKey: `stock-take-counts:${input.stockTakeId}:${crypto.randomUUID()}`,
        endpoint: `/stock-takes/${input.stockTakeId}/counts`,
        method: 'POST',
        body: {
          counts: input.counts.map((c) => ({
            ...c,
            countIdempotencyKey: `${input.stockTakeId}:${c.productId}`,
          })),
        },
        enqueuedAt: Date.now(),
        label: `Stock-take — ${input.counts.length} count${input.counts.length === 1 ? '' : 's'}`,
      };
      return submitOrQueue(pwaQueue, action, sendAction);
    },
  });
}

export function useApproveStockTake() {
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/stock-takes/${id}/approve`, { method: 'POST' }),
  });
}

/**
 * One end-of-bake line as the server validates it (defect F-8 — the client
 * type had drifted, omitting both fields the mode toggle turns on, so a
 * REMAINING line type-checked while carrying nothing the server could use).
 */
export interface ConsumptionLineDraft {
  productId: string;
  /** Which figure this line is answering with. */
  entryMode?: 'CONSUMED' | 'REMAINING';
  actualQty: number;
  /** What is left, when `entryMode === 'REMAINING'`. */
  remainingQty?: number;
  wastageQty?: number;
  wastageReason?: string | null;
}

export interface ConsumptionSubmitDraft {
  sessionId: string;
  siteId: string;
  sessionDate: string;
  bakerName: string;
  bake?: string | null;
  /** TOTAL tables. */
  covers?: number;
  glutenFreeTables?: number;
  veganTables?: number;
  lines: ConsumptionLineDraft[];
  notes?: string | null;
}

/** Head-baker consumption submit — offline-tolerant. The per-session `clientKey`
 *  makes a replay a no-op (server amends in place, never duplicates). */
export function useSubmitConsumption() {
  return useMutation<SubmitResult, Error, ConsumptionSubmitDraft>({
    mutationFn: (input) => {
      const action: QueuedAction = {
        idempotencyKey: `consumption:${input.sessionId}:${crypto.randomUUID()}`,
        endpoint: '/session-consumption',
        method: 'POST',
        body: { ...input, clientKey: '' },
        enqueuedAt: Date.now(),
        label: `End of bake — ${input.bake || 'session'} (${input.lines.length} ingredients)`,
      };
      (action.body as { clientKey: string }).clientKey = action.idempotencyKey;
      return submitOrQueue(pwaQueue, action, sendAction);
    },
  });
}

/** Replay any queued offline actions (call when connectivity returns). */
export function flushPwaQueue() {
  return syncQueue(pwaQueue, sendAction);
}

// ── Queue observability + replay (defects A-2, A-3, A-4) ────────────────────

export interface PwaQueueState {
  /** Actions waiting to be sent. */
  pending: QueuedAction[];
  /** Actions that failed `maxAttempts` times and need a human. */
  deadLettered: QueuedAction[];
  isFlushing: boolean;
  isOnline: boolean;
  lastSyncedAt: number | null;
}

const readOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine);

/**
 * Live view of the offline queue. The sync pill and the queue drawer both read
 * from here — never from a mutation's `isPending`, which was defect A-3: it
 * only knows about the submit happening *right now*, so a queue holding a
 * week of unsent counts still rendered "All saved".
 */
export function usePwaQueueState(): PwaQueueState {
  const [pending, setPending] = React.useState<QueuedAction[]>([]);
  const [deadLettered, setDeadLettered] = React.useState<QueuedAction[]>([]);
  const [isOnline, setIsOnline] = React.useState(readOnline);

  const refresh = React.useCallback(() => {
    void pwaQueue.list().then(setPending);
    void pwaQueue.deadLetters().then(setDeadLettered);
  }, []);

  React.useEffect(() => {
    refresh();
    const unsubscribe = pwaQueue.subscribe(refresh);
    const unsubscribeFlush = subscribeFlushState(refresh);
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      unsubscribe();
      unsubscribeFlush();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refresh]);

  const flushState = useFlushState();

  return {
    pending,
    deadLettered,
    isFlushing: flushState.isFlushing,
    isOnline,
    lastSyncedAt: flushState.lastSyncedAt,
  };
}

// Flush progress is process-global (one queue, one replayer), so it lives
// outside React and is published to subscribers rather than lifted into a
// context nobody else needs.
let flushing = false;
let lastSyncedAt: number | null = null;
const flushListeners = new Set<() => void>();

function subscribeFlushState(listener: () => void): () => void {
  flushListeners.add(listener);
  return () => flushListeners.delete(listener);
}

function publishFlushState(): void {
  for (const l of [...flushListeners]) l();
}

function useFlushState(): { isFlushing: boolean; lastSyncedAt: number | null } {
  const [state, setState] = React.useState({ isFlushing: flushing, lastSyncedAt });
  React.useEffect(() => {
    const update = () => setState({ isFlushing: flushing, lastSyncedAt });
    update();
    return subscribeFlushState(update);
  }, []);
  return state;
}

/**
 * Replay the queue, guarding against overlapping runs. Two triggers can fire
 * within a frame of each other (`online` + `visibilitychange` when an iPad is
 * unlocked in a venue with flaky wifi); a second concurrent flush would send
 * the same action twice and race the removals.
 */
export async function flushPwaQueueOnce(): Promise<void> {
  if (flushing) return;
  if (!readOnline()) return;
  flushing = true;
  publishFlushState();
  try {
    await flushPwaQueue();
    lastSyncedAt = Date.now();
  } finally {
    flushing = false;
    publishFlushState();
  }
}

/**
 * Mount-once wiring that actually replays the queue.
 *
 * **Defect A-2: `flushPwaQueue` had zero call sites.** Work was captured
 * offline and then sat in localStorage for ever. This component is its home —
 * it flushes on app boot, whenever the browser reports `online`, and whenever
 * the tab becomes visible again (an iPad coming out of standby fires
 * `visibilitychange`, often without an `online` event).
 */
export function PwaQueueSync(): null {
  React.useEffect(() => {
    void flushPwaQueueOnce();

    const onOnline = () => void flushPwaQueueOnce();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void flushPwaQueueOnce();
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}

/** Test seam — resets the module-level flush state between specs. */
export function __resetPwaQueueSyncState(): void {
  flushing = false;
  lastSyncedAt = null;
}
