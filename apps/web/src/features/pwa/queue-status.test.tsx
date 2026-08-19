/**
 * Sync pill + queue drawer (Aug-2026 feedback set, A-3/A-4).
 *
 * The pill's `pending` and `offline` branches were dead code because it was
 * driven from `mutation.isPending`. These specs make them live, and prove a
 * venue user can see and act on unsent work without ringing head office.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pwaQueue, __resetPwaQueueSyncState } from './use-pwa-jobs';
import { PwaSyncPill } from './queue-status';

async function clearQueue() {
  for (const a of await pwaQueue.list()) await pwaQueue.discard(a.idempotencyKey);
  for (const a of await pwaQueue.deadLetters()) await pwaQueue.discard(a.idempotencyKey);
}

const queued = (key: string, label: string) => ({
  idempotencyKey: key,
  endpoint: '/goods-in',
  method: 'POST',
  body: {},
  enqueuedAt: Date.now(),
  label,
});

beforeEach(async () => {
  localStorage.clear();
  await clearQueue();
  __resetPwaQueueSyncState();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => vi.restoreAllMocks());

describe('PwaSyncPill', () => {
  it('reads "All saved" only when the queue is genuinely empty', async () => {
    render(<PwaSyncPill />);
    expect(await screen.findByText('All saved')).toBeInTheDocument();
  });

  it('A-3: shows a pending COUNT when work is queued', async () => {
    await pwaQueue.enqueue(queued('a', 'Goods in — 3 lines'));
    await pwaQueue.enqueue(queued('b', 'Stock-take — 12 counts'));
    render(<PwaSyncPill />);
    expect(await screen.findByText('Pending 2')).toBeInTheDocument();
  });

  it('A-3: shows offline when the browser is offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await pwaQueue.enqueue(queued('a', 'Goods in — 3 lines'));
    render(<PwaSyncPill />);
    expect(await screen.findByText(/offline — 1 waiting/i)).toBeInTheDocument();
  });

  it('A-4: tapping the pill opens a drawer listing the queued work', async () => {
    const user = userEvent.setup();
    await pwaQueue.enqueue({ ...queued('a', 'Goods in — 3 lines'), attempts: 2, lastError: 'Service Unavailable' });
    render(<PwaSyncPill />);

    await user.click(await screen.findByRole('button', { name: /sync status/i }));

    expect(await screen.findByText('Goods in — 3 lines')).toBeInTheDocument();
    expect(screen.getByText(/2 attempts · Service Unavailable/)).toBeInTheDocument();
  });

  it('A-4: discard requires a confirmation before it removes anything', async () => {
    const user = userEvent.setup();
    await pwaQueue.enqueue(queued('a', 'Goods in — 3 lines'));
    render(<PwaSyncPill />);

    await user.click(await screen.findByRole('button', { name: /sync status/i }));
    await user.click(screen.getByRole('button', { name: /^discard$/i }));

    // First tap only arms it — the action is still queued.
    expect(await pwaQueue.size()).toBe(1);
    await user.click(screen.getByRole('button', { name: /really discard/i }));
    await waitFor(async () => expect(await pwaQueue.size()).toBe(0));
  });
});
