/**
 * Offline-aware submit (P13, spec §A1).
 *
 * The iPad jobs (goods-in, stock-take counts, end-of-bake consumption) submit
 * through this: online, they POST immediately; offline (or on a *transport*
 * failure) they're queued and replayed when connectivity returns. Each action
 * carries a client idempotency id, so a replay never double-applies (the
 * goods-in / stock-take services dedupe on it server-side).
 *
 * ── Defect A-1, the reason this file was rewritten ──────────────────────────
 *
 * This used to be `catch { enqueue(); return 'queued' }`. Every failure —
 * including an HTTP 400 the server had *refused* — was reported to the venue as
 * "Saved offline — will sync". Bakers were told their work was saved when it
 * had been discarded. Worse, the queue was never replayed (A-2), so even the
 * genuinely-queued work never landed.
 *
 * The classification is now explicit, and it turns on one question: **will
 * retrying this ever succeed?**
 *
 *  - **Transport failure** (`TypeError` from `fetch`, or `navigator.onLine`
 *    false) → the payload never reached the server. Queue it, say so.
 *  - **HTTP 4xx** (excluding 408 and 429) → the server looked at the payload
 *    and refused it. It will refuse it identically on every retry; queuing it
 *    is a lie that compounds. Return `'rejected'` and put the error in front of
 *    the user with their entries still on screen.
 *  - **HTTP 5xx / 408 / 429** → the server is unwell, not the payload. Queue
 *    it, stamped with an attempt count so it can eventually dead-letter rather
 *    than retry forever.
 */
import { ApiError } from './api-client';
import type { OfflineQueue, QueuedAction } from './offline-queue';

export type SendFn = (action: QueuedAction) => Promise<unknown>;

export type SubmitOutcome = 'sent' | 'queued' | 'rejected';

export interface SubmitResult<T = unknown> {
  status: SubmitOutcome;
  /** Present when `status === 'rejected'` — the server's own refusal. */
  error?: ApiError;
  /**
   * The server's response, when it reached the server (`'sent'`).
   *
   * Goods-in needs the receipt id back so the screen can offer an Undo
   * (defect E-3) and show a receipt (A-5). A queued action has no response
   * yet by definition — and correspondingly, no Undo to offer.
   */
  data?: T;
}

/**
 * A 4xx that is genuinely the payload's fault. 408 (Request Timeout) and 429
 * (Too Many Requests) are 4xx by number but transient by nature: retrying
 * those is exactly right, so they queue.
 */
export function isRejection(err: unknown): err is ApiError {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 408 || err.status === 429) return false;
  return err.status >= 400 && err.status < 500;
}

export async function submitOrQueue<T = unknown>(
  queue: OfflineQueue,
  action: QueuedAction,
  send: SendFn,
  isOnline: () => boolean = () => (typeof navigator === 'undefined' ? true : navigator.onLine),
): Promise<SubmitResult<T>> {
  if (!isOnline()) {
    await queue.enqueue(action);
    return { status: 'queued' };
  }

  try {
    const data = (await send(action)) as T;
    return { status: 'sent', data };
  } catch (err) {
    if (isRejection(err)) {
      // Deliberately NOT enqueued. See the header — a refused payload is
      // refused every time, and queuing it would report success for work the
      // server has already thrown away.
      return { status: 'rejected', error: err };
    }
    await queue.enqueue({
      ...action,
      attempts: (action.attempts ?? 0) + 1,
      lastError: err instanceof Error ? err.message : String(err),
      lastTriedAt: Date.now(),
    });
    return { status: 'queued' };
  }
}

/** Replay everything queued (call on reconnect). Returns the flush counts. */
export function syncQueue(queue: OfflineQueue, send: SendFn) {
  return queue.flush(send);
}
