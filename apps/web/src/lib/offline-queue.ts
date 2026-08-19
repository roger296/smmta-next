/**
 * Offline action queue (P12, spec §A1/§A11; hardened by the Aug-2026 feedback
 * set, defects A-1 … A-4).
 *
 * iPad workflows (counts, goods-in lines) are captured locally and synced when
 * connectivity returns. Each action carries a client `idempotencyKey` that the
 * server-side services (goods-in / stock-take) honour, so a replay never
 * double-applies. The queue itself is keyed by that idempotency key, so
 * enqueuing the same action twice never duplicates it; a `flush` removes only
 * the actions the sender accepted, leaving failures for the next attempt.
 *
 * Two things the 12 Aug venue test proved this layer needed:
 *
 *  - **Attempt accounting.** An action that fails forever used to be retried
 *    forever, silently. It now carries `attempts` / `lastError` / `lastTriedAt`
 *    and moves to a **dead-letter** list after `maxAttempts`, where a human can
 *    see it, retry it or discard it. A queue that never gives up is
 *    indistinguishable from a queue that never runs.
 *  - **Observability.** `size()` and `subscribe()` let the UI show a real
 *    pending count, so a baker can answer "did my count go in?" without ringing
 *    head office.
 *
 * Storage is pluggable (localStorage in the browser, in-memory in tests).
 */
export interface QueuedAction {
  idempotencyKey: string;
  endpoint: string;
  method: string;
  body: unknown;
  enqueuedAt: number;
  /** How many send attempts this action has survived. */
  attempts?: number;
  /** The message from the most recent failure, for the queue drawer. */
  lastError?: string;
  /** When the most recent attempt happened (epoch ms). */
  lastTriedAt?: number;
  /** Human label for the queue drawer, e.g. "Goods in — 3 lines". */
  label?: string;
}

export interface QueueStorage {
  getAll(): Promise<QueuedAction[]>;
  put(action: QueuedAction): Promise<void>;
  remove(idempotencyKey: string): Promise<void>;
  /** Dead-lettered actions — failed `maxAttempts` times, awaiting a human. */
  getDead(): Promise<QueuedAction[]>;
  putDead(action: QueuedAction): Promise<void>;
  removeDead(idempotencyKey: string): Promise<void>;
}

export class InMemoryQueueStorage implements QueueStorage {
  private map = new Map<string, QueuedAction>();
  private dead = new Map<string, QueuedAction>();
  async getAll(): Promise<QueuedAction[]> {
    return [...this.map.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  async put(action: QueuedAction): Promise<void> {
    this.map.set(action.idempotencyKey, action);
  }
  async remove(idempotencyKey: string): Promise<void> {
    this.map.delete(idempotencyKey);
  }
  async getDead(): Promise<QueuedAction[]> {
    return [...this.dead.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  async putDead(action: QueuedAction): Promise<void> {
    this.dead.set(action.idempotencyKey, action);
  }
  async removeDead(idempotencyKey: string): Promise<void> {
    this.dead.delete(idempotencyKey);
  }
}

const LS_KEY = 'autostock_offline_queue';
const LS_DEAD_KEY = 'autostock_offline_dead_letter';

export class LocalStorageQueueStorage implements QueueStorage {
  private read(key: string): Record<string, QueuedAction> {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, QueuedAction>;
    } catch {
      return {};
    }
  }
  private write(key: string, map: Record<string, QueuedAction>): void {
    try {
      localStorage.setItem(key, JSON.stringify(map));
    } catch {
      // storage full / unavailable — drop silently (best-effort offline cache)
    }
  }
  async getAll(): Promise<QueuedAction[]> {
    return Object.values(this.read(LS_KEY)).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  async put(action: QueuedAction): Promise<void> {
    const map = this.read(LS_KEY);
    map[action.idempotencyKey] = action;
    this.write(LS_KEY, map);
  }
  async remove(idempotencyKey: string): Promise<void> {
    const map = this.read(LS_KEY);
    delete map[idempotencyKey];
    this.write(LS_KEY, map);
  }
  async getDead(): Promise<QueuedAction[]> {
    return Object.values(this.read(LS_DEAD_KEY)).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  async putDead(action: QueuedAction): Promise<void> {
    const map = this.read(LS_DEAD_KEY);
    map[action.idempotencyKey] = action;
    this.write(LS_DEAD_KEY, map);
  }
  async removeDead(idempotencyKey: string): Promise<void> {
    const map = this.read(LS_DEAD_KEY);
    delete map[idempotencyKey];
    this.write(LS_DEAD_KEY, map);
  }
}

/** Give up on an action after this many failed sends (defect A-4). */
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface FlushResult {
  sent: number;
  failed: number;
  /** Actions that hit `maxAttempts` on this flush and were dead-lettered. */
  deadLettered: number;
}

export class OfflineQueue {
  private listeners = new Set<() => void>();

  constructor(
    private readonly storage: QueueStorage,
    private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  ) {}

  /** Observe queue changes — the sync pill and the queue drawer both need to
   *  re-read after any enqueue / flush / discard. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Queue an action. Enqueuing the same idempotency key again replaces it
   *  (never duplicates). */
  async enqueue(action: Omit<QueuedAction, 'enqueuedAt'> & { enqueuedAt?: number }): Promise<void> {
    await this.storage.put({ enqueuedAt: action.enqueuedAt ?? 0, ...action } as QueuedAction);
    this.notify();
  }

  async size(): Promise<number> {
    return (await this.storage.getAll()).length;
  }

  async list(): Promise<QueuedAction[]> {
    return this.storage.getAll();
  }

  async deadLetters(): Promise<QueuedAction[]> {
    return this.storage.getDead();
  }

  async deadLetterCount(): Promise<number> {
    return (await this.storage.getDead()).length;
  }

  /** Drop an action for good — from either list. Used by the queue drawer's
   *  "discard", which is confirmed before it fires. */
  async discard(idempotencyKey: string): Promise<void> {
    await this.storage.remove(idempotencyKey);
    await this.storage.removeDead(idempotencyKey);
    this.notify();
  }

  /** Move a dead letter back to the live queue so the next flush retries it. */
  async revive(idempotencyKey: string): Promise<void> {
    const dead = await this.storage.getDead();
    const found = dead.find((a) => a.idempotencyKey === idempotencyKey);
    if (!found) return;
    await this.storage.removeDead(idempotencyKey);
    await this.storage.put({ ...found, attempts: 0, lastError: undefined });
    this.notify();
  }

  /**
   * Replay queued actions through `send`. Successfully-sent actions are
   * removed; ones that throw have their attempt count bumped and stay queued —
   * until `maxAttempts`, at which point they move to the dead-letter list
   * rather than being retried forever.
   */
  async flush(
    send: (action: QueuedAction) => Promise<unknown>,
    now: () => number = () => Date.now(),
  ): Promise<FlushResult> {
    let sent = 0;
    let failed = 0;
    let deadLettered = 0;
    for (const action of await this.storage.getAll()) {
      try {
        await send(action);
        await this.storage.remove(action.idempotencyKey);
        sent += 1;
      } catch (err) {
        failed += 1;
        const attempts = (action.attempts ?? 0) + 1;
        const updated: QueuedAction = {
          ...action,
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
          lastTriedAt: now(),
        };
        if (attempts >= this.maxAttempts) {
          await this.storage.remove(action.idempotencyKey);
          await this.storage.putDead(updated);
          deadLettered += 1;
        } else {
          await this.storage.put(updated);
        }
      }
    }
    this.notify();
    return { sent, failed, deadLettered };
  }
}
