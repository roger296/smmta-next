import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import {
  OfflineQueue,
  LocalStorageQueueStorage,
  type QueuedAction,
} from '@/lib/offline-queue';
import { submitOrQueue, syncQueue } from '@/lib/offline-submit';

/** Shared offline queue for the iPad jobs. */
export const pwaQueue = new OfflineQueue(new LocalStorageQueueStorage());

const sendAction = (a: QueuedAction): Promise<void> =>
  apiFetch(a.endpoint, { method: a.method, body: a.body }).then(() => undefined);

export interface GoodsInLineDraft {
  productId: string;
  qtyPurchase: number;
  unitCost?: number;
}

/** Goods-in submit — offline-tolerant (queues + replays with one idempotency key). */
export function useReceiveGoodsIn() {
  return useMutation<
    { status: 'sent' | 'queued' },
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
        enqueuedAt: 0,
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
    { status: 'sent' | 'queued' },
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
        enqueuedAt: 0,
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

export interface ConsumptionLineDraft {
  productId: string;
  actualQty: number;
  wastageQty?: number;
  wastageReason?: string | null;
}

export interface ConsumptionSubmitDraft {
  sessionId: string;
  siteId: string;
  sessionDate: string;
  bakerName: string;
  coverGroups?: Array<{ experience: 'CLASSIC' | 'SWEETER' | 'ULTIMATE'; covers: number }>;
  lines: ConsumptionLineDraft[];
  notes?: string | null;
}

/** Head-baker consumption submit — offline-tolerant. The per-session `clientKey`
 *  makes a replay a no-op (server amends in place, never duplicates). */
export function useSubmitConsumption() {
  return useMutation<{ status: 'sent' | 'queued' }, Error, ConsumptionSubmitDraft>({
    mutationFn: (input) => {
      const action: QueuedAction = {
        idempotencyKey: `consumption:${input.sessionId}:${crypto.randomUUID()}`,
        endpoint: '/session-consumption',
        method: 'POST',
        body: { ...input, clientKey: '' },
        enqueuedAt: 0,
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
