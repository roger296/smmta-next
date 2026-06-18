/**
 * Offline queue (P12). Persists actions and replays without duplication.
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryQueueStorage, OfflineQueue, type QueuedAction } from './offline-queue';

const action = (key: string, enqueuedAt = 0): Omit<QueuedAction, 'enqueuedAt'> & { enqueuedAt: number } => ({
  idempotencyKey: key,
  endpoint: '/goods-in',
  method: 'POST',
  body: { key },
  enqueuedAt,
});

describe('OfflineQueue', () => {
  it('does not duplicate an action enqueued twice with the same key', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    await q.enqueue(action('a', 1));
    await q.enqueue(action('b', 2));
    await q.enqueue(action('a', 3)); // same key as the first
    expect(await q.size()).toBe(2);
  });

  it('flushes successfully-sent actions and keeps failures', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    await q.enqueue(action('a', 1));
    await q.enqueue(action('b', 2));

    const send = vi.fn(async (a: QueuedAction) => {
      if (a.idempotencyKey === 'b') throw new Error('offline');
    });
    const res = await q.flush(send);
    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    // 'a' was accepted (removed), 'b' stays for the next flush.
    expect(await q.size()).toBe(1);
  });

  it('replays without re-sending an already-flushed action', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    await q.enqueue(action('a', 1));
    const send = vi.fn(async () => {});
    await q.flush(send); // sends + removes 'a'
    await q.flush(send); // nothing left
    expect(send).toHaveBeenCalledTimes(1);
    expect(await q.size()).toBe(0);
  });
});
