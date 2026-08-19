/**
 * Queue replay + observability (Aug-2026 feedback set, A-2/A-3).
 *
 * A-2 was not a subtle bug: `flushPwaQueue` had **zero production call sites**.
 * Anything captured offline stayed in localStorage for ever. These specs pin
 * the three triggers that now replay it, and prove queue depth reaches the UI.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { render, renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import {
  PwaQueueSync,
  pwaQueue,
  usePwaQueueState,
  __resetPwaQueueSyncState,
} from './use-pwa-jobs';

const API = 'http://localhost:8080/api/v1';

async function clearQueue() {
  for (const a of await pwaQueue.list()) await pwaQueue.discard(a.idempotencyKey);
  for (const a of await pwaQueue.deadLetters()) await pwaQueue.discard(a.idempotencyKey);
}

const queued = (key: string) => ({
  idempotencyKey: key,
  endpoint: '/goods-in',
  method: 'POST',
  body: { idempotencyKey: key },
  enqueuedAt: Date.now(),
  label: 'Goods in — 1 line',
});

beforeEach(async () => {
  localStorage.clear();
  await clearQueue();
  __resetPwaQueueSyncState();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PwaQueueSync', () => {
  it('flushes on boot — the call site defect A-2 was missing entirely', async () => {
    const received: unknown[] = [];
    server.use(
      http.post(`${API}/goods-in`, async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json({ success: true, data: { id: 'gr-1' } });
      }),
    );
    await pwaQueue.enqueue(queued('a'));

    render(<PwaQueueSync />);

    await waitFor(async () => expect(await pwaQueue.size()).toBe(0));
    expect(received).toHaveLength(1);
  });

  it('flushes when the browser comes back online', async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/goods-in`, () => {
        calls += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    render(<PwaQueueSync />);
    await waitFor(() => expect(calls).toBe(0));

    await pwaQueue.enqueue(queued('b'));
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(calls).toBe(1));
    expect(await pwaQueue.size()).toBe(0);
  });

  it('flushes when the tab becomes visible again (iPad waking from standby)', async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/goods-in`, () => {
        calls += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    render(<PwaQueueSync />);
    await waitFor(() => expect(calls).toBe(0));

    await pwaQueue.enqueue(queued('c'));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(calls).toBe(1));
  });

  it('does not attempt a flush while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    let calls = 0;
    server.use(
      http.post(`${API}/goods-in`, () => {
        calls += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );
    await pwaQueue.enqueue(queued('d'));

    render(<PwaQueueSync />);

    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
    expect(await pwaQueue.size()).toBe(1);
  });
});

describe('usePwaQueueState (A-3)', () => {
  it('reports queue depth, and updates when the queue changes', async () => {
    const { result } = renderHook(() => usePwaQueueState());
    await waitFor(() => expect(result.current.pending).toHaveLength(0));

    await act(async () => {
      await pwaQueue.enqueue(queued('e'));
    });

    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(result.current.pending[0]!.label).toBe('Goods in — 1 line');

    await act(async () => {
      await pwaQueue.discard('e');
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(0));
  });

  it('tracks online/offline', async () => {
    const { result } = renderHook(() => usePwaQueueState());
    await waitFor(() => expect(result.current.isOnline).toBe(true));

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await waitFor(() => expect(result.current.isOnline).toBe(false));
  });

  it('surfaces dead letters separately from pending', async () => {
    const { result } = renderHook(() => usePwaQueueState());
    await waitFor(() => expect(result.current.pending).toHaveLength(0));

    await act(async () => {
      await pwaQueue.enqueue(queued('f'));
      // The shared queue gives up after DEFAULT_MAX_ATTEMPTS; drive it there.
      for (let i = 0; i < 5; i += 1) {
        await pwaQueue.flush(async () => {
          throw new Error('Service Unavailable');
        });
      }
    });

    await waitFor(() => expect(result.current.deadLettered).toHaveLength(1));
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.deadLettered[0]!.lastError).toMatch(/Service Unavailable/);
  });
});
