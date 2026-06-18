/**
 * Offline-aware submit (P13, spec §A1). The iPad jobs (goods-in, stock-take
 * counts) submit through this: online, they POST immediately; offline (or on a
 * network failure) they're queued and replayed when connectivity returns. Each
 * action carries a client idempotency id, so a replay never double-applies
 * (the goods-in / stock-take services dedupe on it server-side).
 */
import type { OfflineQueue, QueuedAction } from './offline-queue';

export type SendFn = (action: QueuedAction) => Promise<void>;

export interface SubmitResult {
  status: 'sent' | 'queued';
}

export async function submitOrQueue(
  queue: OfflineQueue,
  action: QueuedAction,
  send: SendFn,
  isOnline: () => boolean = () => (typeof navigator === 'undefined' ? true : navigator.onLine),
): Promise<SubmitResult> {
  if (isOnline()) {
    try {
      await send(action);
      return { status: 'sent' };
    } catch {
      await queue.enqueue(action);
      return { status: 'queued' };
    }
  }
  await queue.enqueue(action);
  return { status: 'queued' };
}

/** Replay everything queued (call on reconnect). Returns the flush counts. */
export function syncQueue(queue: OfflineQueue, send: SendFn) {
  return queue.flush(send);
}
