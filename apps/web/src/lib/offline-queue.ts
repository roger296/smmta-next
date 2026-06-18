/**
 * Offline action queue (P12, spec §A1/§A11).
 *
 * iPad workflows (counts, goods-in lines) are captured locally and synced when
 * connectivity returns. Each action carries a client `idempotencyKey` that the
 * server-side services (goods-in / stock-take) honour, so a replay never
 * double-applies. The queue itself is keyed by that idempotency key, so
 * enqueuing the same action twice never duplicates it; a `flush` removes only
 * the actions the sender accepted, leaving failures for the next attempt.
 *
 * Storage is pluggable (localStorage in the browser, in-memory in tests).
 */
export interface QueuedAction {
  idempotencyKey: string;
  endpoint: string;
  method: string;
  body: unknown;
  enqueuedAt: number;
}

export interface QueueStorage {
  getAll(): Promise<QueuedAction[]>;
  put(action: QueuedAction): Promise<void>;
  remove(idempotencyKey: string): Promise<void>;
}

export class InMemoryQueueStorage implements QueueStorage {
  private map = new Map<string, QueuedAction>();
  async getAll(): Promise<QueuedAction[]> {
    return [...this.map.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  async put(action: QueuedAction): Promise<void> {
    this.map.set(action.idempotencyKey, action);
  }
  async remove(idempotencyKey: string): Promise<void> {
    this.map.delete(idempotencyKey);
  }
}

const LS_KEY = 'autostock_offline_queue';

export class LocalStorageQueueStorage implements QueueStorage {
  private read(): Record<string, QueuedAction> {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Record<string, QueuedAction>;
    } catch {
      return {};
    }
  }
  private write(map: Record<string, QueuedAction>): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(map));
    } catch {
      // storage full / unavailable — drop silently (best-effort offline cache)
    }
  }
  async getAll(): Promise<QueuedAction[]> {
    return Object.values(this.read()).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  async put(action: QueuedAction): Promise<void> {
    const map = this.read();
    map[action.idempotencyKey] = action;
    this.write(map);
  }
  async remove(idempotencyKey: string): Promise<void> {
    const map = this.read();
    delete map[idempotencyKey];
    this.write(map);
  }
}

export class OfflineQueue {
  constructor(private readonly storage: QueueStorage) {}

  /** Queue an action. Enqueuing the same idempotency key again replaces it
   *  (never duplicates). */
  async enqueue(action: Omit<QueuedAction, 'enqueuedAt'> & { enqueuedAt?: number }): Promise<void> {
    await this.storage.put({ enqueuedAt: action.enqueuedAt ?? 0, ...action } as QueuedAction);
  }

  async size(): Promise<number> {
    return (await this.storage.getAll()).length;
  }

  /** Replay queued actions through `send`. Successfully-sent actions are
   *  removed; ones that throw stay queued for the next flush. */
  async flush(
    send: (action: QueuedAction) => Promise<void>,
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const action of await this.storage.getAll()) {
      try {
        await send(action);
        await this.storage.remove(action.idempotencyKey);
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    return { sent, failed };
  }
}
