/**
 * Offline-aware submit (P13). Online sends; offline/failure queues; a reconnect
 * flush applies each queued action exactly once.
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryQueueStorage, OfflineQueue, type QueuedAction } from './offline-queue';
import { submitOrQueue, syncQueue } from './offline-submit';
import { purchaseToStock, bucketCount } from './uom';

const action = (key: string): QueuedAction => ({
  idempotencyKey: key,
  endpoint: '/goods-in',
  method: 'POST',
  body: { key },
  enqueuedAt: 0,
});

describe('submitOrQueue', () => {
  it('sends immediately when online', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    const send = vi.fn(async () => {});
    const res = await submitOrQueue(q, action('a'), send, () => true);
    expect(res.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(await q.size()).toBe(0);
  });

  it('queues when offline', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    const send = vi.fn(async () => {});
    const res = await submitOrQueue(q, action('a'), send, () => false);
    expect(res.status).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    expect(await q.size()).toBe(1);
  });

  it('queues on a network failure even when "online"', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    const send = vi.fn(async () => {
      throw new Error('network');
    });
    const res = await submitOrQueue(q, action('a'), send, () => true);
    expect(res.status).toBe('queued');
    expect(await q.size()).toBe(1);
  });

  it('applies a queued action exactly once on reconnect', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    // Two offline submits.
    await submitOrQueue(q, action('a'), async () => {}, () => false);
    await submitOrQueue(q, action('b'), async () => {}, () => false);
    expect(await q.size()).toBe(2);

    const send = vi.fn(async () => {});
    const res1 = await syncQueue(q, send);
    expect(res1.sent).toBe(2);
    expect(await q.size()).toBe(0);
    // A second flush sends nothing more.
    const res2 = await syncQueue(q, send);
    expect(res2.sent).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('uom helpers', () => {
  it('converts purchase to stock units', () => {
    expect(purchaseToStock(5, 1000)).toBe(5000);
  });
  it('buckets fungible counts and leaves discrete untouched', () => {
    expect(bucketCount(1234, 'g')).toBe(1200);
    expect(bucketCount(7, 'each')).toBe(7);
  });
});
