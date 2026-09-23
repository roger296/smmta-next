import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import {
  OfflineQueue,
  LocalStorageQueueStorage,
  type QueuedAction,
} from '@/lib/offline-queue';
import { submitOrQueue, syncQueue, type SubmitResult } from '@/lib/offline-submit';
import { recordShiftEntry, type ShiftJobKind } from './shift-log';

/** Shared offline queue for the iPad jobs. */
export const pwaQueue = new OfflineQueue(new LocalStorageQueueStorage());

const sendAction = (a: QueuedAction): Promise<unknown> =>
  apiFetch(a.endpoint, { method: a.method, body: a.body });

/**
 * File the job, then note it in this sign-in's shift log (item 9).
 *
 * The log is written HERE, at the one point every venue job passes through,
 * rather than in each screen's success handler — a screen that forgot to call
 * it would leave a baker looking at a page that says they never did the work.
 *
 * A REJECTED submit is deliberately not logged: it did not happen, and a list
 * of things that did not happen is the opposite of reassuring.
 */
async function submitAndLog<T>(
  action: QueuedAction,
  kind: ShiftJobKind,
  detail?: string,
): Promise<SubmitResult<T>> {
  const result = await submitOrQueue<T>(pwaQueue, action, sendAction);
  if (result.status !== 'rejected') {
    recordShiftEntry({ kind, label: action.label ?? '', detail, status: result.status });
  }
  return result;
}

export interface GoodsInLineDraft {
  productId: string;
  qtyPurchase: number;
  unitCost?: number;
  batchCode?: string;
  useBy?: string | null;
}

/** What `POST /goods-in` returns — enough for the receipt screen and Undo. */
export interface GoodsInReceiptResult {
  receipt: {
    id: string;
    siteId: string;
    reference: string | null;
    totalStockValue: string;
    receivedAt: string;
  };
  lines: Array<{
    id: string;
    productId: string;
    qtyPurchase: string;
    qtyStock: string;
    unitCost: string;
    lineValue: string;
  }>;
  alreadyExisted: boolean;
}

/** Goods-in submit — offline-tolerant (queues + replays with one idempotency key). */
export function useReceiveGoodsIn() {
  return useMutation<
    SubmitResult<GoodsInReceiptResult>,
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
      return submitAndLog<GoodsInReceiptResult>(action, 'GOODS_IN');
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
            // One key per SAVE of a line, not per line. The server ignores a
            // count whose key it has already recorded — that is what makes an
            // offline replay safe, and the replay resends this same body, so
            // it still carries the same key. The key used to be take+product
            // alone, which made EVERY later save of a product look like a
            // replay: once an item was counted, no correction ever landed, and
            // the screen still said "Counts saved". With two counters on one
            // take that also swallowed one person's correction of the other's.
            countIdempotencyKey: `${input.stockTakeId}:${c.productId}:${crypto.randomUUID()}`,
          })),
        },
        enqueuedAt: Date.now(),
        label: `Stock-take — ${input.counts.length} count${input.counts.length === 1 ? '' : 's'}`,
      };
      return submitAndLog(action, 'STOCK_TAKE');
    },
  });
}

/**
 * Undo a booking by issuing a REVERSING receipt (defect E-3).
 *
 * Deliberately NOT offline-queued. An undo is a 90-second window on a screen
 * someone is looking at; queuing it would mean the reversal lands minutes or
 * hours later, long after the person has walked away believing it was done —
 * the same class of lie as A-1. Offline, the Undo button says so instead.
 */
export function useReverseGoodsIn() {
  return useMutation<unknown, Error, { receiptId: string; reason?: string }>({
    mutationFn: ({ receiptId, reason }) =>
      apiFetch(`/goods-in/${receiptId}/reverse`, {
        method: 'POST',
        body: { reason: reason ?? 'Undone from the venue screen' },
      }),
  });
}

/** A take in the venue's "join a count" list (GET /stock-takes). */
export interface OpenStockTake {
  id: string;
  scope: string;
  createdAt: string;
  openedByName: string | null;
  lineCount: number;
  countedCount: number;
  counters: string[];
  lastCountedAt: string | null;
}

/**
 * The venue's open takes, so a second counter JOINS the count in progress
 * instead of starting a parallel one nobody else can see.
 */
export function useOpenStockTakes(siteId: string | null | undefined, enabled = true) {
  return useQuery<OpenStockTake[]>({
    queryKey: ['stock-takes', 'open', siteId],
    // Anything but a list reads as "none open": the start screen must always
    // be able to start a count, whatever this request returns.
    queryFn: async () => {
      const res = await apiFetch<unknown>('/stock-takes', { searchParams: { siteId: siteId!, status: 'OPEN' } });
      return Array.isArray(res) ? (res as OpenStockTake[]) : [];
    },
    enabled: Boolean(siteId) && enabled,
  });
}

/** How often the count screen re-reads the take for other counters' saves. */
export const SHARED_TAKE_POLL_MS = 15_000;

/**
 * One take with its lines, re-read every SHARED_TAKE_POLL_MS so each counter
 * sees what the others have saved. A failed re-read keeps the last good copy
 * on screen — the counter is still counting, and an empty sheet would be far
 * worse than a slightly stale one.
 */
export function useStockTake<T>(takeId: string | null) {
  return useQuery<T>({
    queryKey: ['stock-take', takeId],
    queryFn: () => apiFetch<T>(`/stock-takes/${takeId}`),
    enabled: Boolean(takeId),
    refetchInterval: SHARED_TAKE_POLL_MS,
    refetchOnWindowFocus: true,
    // Seeded from the open/join response; don't immediately re-fetch what we
    // were just handed.
    staleTime: 5_000,
    retry: 1,
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
      return submitAndLog(action, 'CONSUMPTION', `Session ${input.sessionId} · ${input.bakerName}`);
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
