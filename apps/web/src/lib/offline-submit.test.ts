/**
 * Offline-aware submit (P13; rewritten for the Aug-2026 feedback set).
 *
 * Online sends; a *transport* failure queues; a server **rejection** does not.
 * A reconnect flush applies each queued action exactly once, and an action
 * that keeps failing eventually dead-letters instead of retrying for ever.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-client';
import { InMemoryQueueStorage, OfflineQueue, type QueuedAction } from './offline-queue';
import { isRejection, submitOrQueue, syncQueue } from './offline-submit';
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

  it('queues when offline, without attempting a send', async () => {
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
      throw new TypeError('Failed to fetch');
    });
    const res = await submitOrQueue(q, action('a'), send, () => true);
    expect(res.status).toBe('queued');
    expect(await q.size()).toBe(1);
  });

  // ── A-1: the defect this file exists to prevent recurring ────────────────
  it('A-1: a 400 is REJECTED and is not enqueued', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    const send = vi.fn(async () => {
      throw new ApiError('Line 2: qtyPurchase must be greater than 0', 400);
    });
    const res = await submitOrQueue(q, action('a'), send, () => true);
    expect(res.status).toBe('rejected');
    expect(res.error?.status).toBe(400);
    expect(res.error?.message).toMatch(/qtyPurchase/);
    // The critical assertion: NOT queued. Queuing a payload the server has
    // already refused is the lie that told bakers their work was saved.
    expect(await q.size()).toBe(0);
  });

  it.each([403, 404, 409, 422])('A-1: a %i is rejected, not queued', async (status) => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    const send = async () => {
      throw new ApiError(`refused ${status}`, status);
    };
    const res = await submitOrQueue(q, action('a'), send, () => true);
    expect(res.status).toBe('rejected');
    expect(await q.size()).toBe(0);
  });

  it('a 500 enqueues — the server is unwell, not the payload', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    const send = async () => {
      throw new ApiError('Internal Server Error', 500);
    };
    const res = await submitOrQueue(q, action('a'), send, () => true);
    expect(res.status).toBe('queued');
    expect(await q.size()).toBe(1);
    const [queued] = await q.list();
    expect(queued!.attempts).toBe(1);
    expect(queued!.lastError).toMatch(/Internal Server Error/);
  });

  it.each([408, 429])('a %i enqueues despite being 4xx — it is transient', async (status) => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    const send = async () => {
      throw new ApiError(`transient ${status}`, status);
    };
    const res = await submitOrQueue(q, action('a'), send, () => true);
    expect(res.status).toBe('queued');
    expect(await q.size()).toBe(1);
  });

  it('applies a queued action exactly once on reconnect', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    await submitOrQueue(q, action('a'), async () => {}, () => false);
    await submitOrQueue(q, action('b'), async () => {}, () => false);
    expect(await q.size()).toBe(2);

    const send = vi.fn(async () => {});
    const res1 = await syncQueue(q, send);
    expect(res1.sent).toBe(2);
    expect(await q.size()).toBe(0);
    const res2 = await syncQueue(q, send);
    expect(res2.sent).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('dead-letters an action after N failed attempts rather than retrying forever', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage(), 3);
    await submitOrQueue(q, action('a'), async () => {}, () => false);

    const send = async () => {
      throw new ApiError('Service Unavailable', 503);
    };
    await syncQueue(q, send); // attempt 1
    expect(await q.size()).toBe(1);
    await syncQueue(q, send); // attempt 2
    expect(await q.size()).toBe(1);
    const third = await syncQueue(q, send); // attempt 3 — gives up

    expect(third.deadLettered).toBe(1);
    expect(await q.size()).toBe(0);
    const dead = await q.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]!.lastError).toMatch(/Service Unavailable/);
  });

  it('a dead letter can be revived and retried', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage(), 1);
    await submitOrQueue(q, action('a'), async () => {}, () => false);
    await syncQueue(q, async () => {
      throw new ApiError('down', 503);
    });
    expect(await q.deadLetterCount()).toBe(1);

    await q.revive('a');
    expect(await q.size()).toBe(1);
    expect(await q.deadLetterCount()).toBe(0);

    const res = await syncQueue(q, async () => {});
    expect(res.sent).toBe(1);
  });

  it('discarding removes an action from both lists', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    await submitOrQueue(q, action('a'), async () => {}, () => false);
    await q.discard('a');
    expect(await q.size()).toBe(0);
  });

  it('notifies subscribers when the queue changes', async () => {
    const q = new OfflineQueue(new InMemoryQueueStorage());
    const listener = vi.fn();
    const unsubscribe = q.subscribe(listener);
    await q.enqueue(action('a'));
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    await q.enqueue(action('b'));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('isRejection', () => {
  it('classifies by status, and only for ApiError', () => {
    expect(isRejection(new ApiError('bad', 400))).toBe(true);
    expect(isRejection(new ApiError('gone', 410))).toBe(true);
    expect(isRejection(new ApiError('timeout', 408))).toBe(false);
    expect(isRejection(new ApiError('slow down', 429))).toBe(false);
    expect(isRejection(new ApiError('boom', 500))).toBe(false);
    expect(isRejection(new TypeError('Failed to fetch'))).toBe(false);
    expect(isRejection('not an error')).toBe(false);
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
