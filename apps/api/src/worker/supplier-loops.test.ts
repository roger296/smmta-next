/**
 * Unit tests for the worker's drop-ship loops. The poll and placer calls are
 * injected, so no database or supplier is involved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  startSupplierOrderPlacerLoop,
  startSupplierPollLoops,
  type SupplierLoopHandle,
} from './supplier-loops.js';
import type { SupplierPollOutcome } from '../workers/supplier-poll.worker.js';

const logger = pino({ level: 'silent' });
const handles: SupplierLoopHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.stop();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('startSupplierPollLoops', () => {
  it('polls each supplier in its own lane and never starts a lane twice', async () => {
    const calls: string[] = [];
    const slowA = deferred<SupplierPollOutcome[]>();
    const handle = startSupplierPollLoops({
      logger,
      startImmediately: false,
      listSupplierIds: async () => ['a', 'b'],
      pollSupplier: (id) => {
        calls.push(id);
        return id === 'a' ? slowA.promise : Promise.resolve([]);
      },
    });
    handles.push(handle);

    const first = handle.runOnce();
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b']));
    // b has finished; a is still polling (a Ralawise sweep, say).
    await new Promise((r) => setTimeout(r, 0));
    const second = handle.runOnce();
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b', 'b']));

    slowA.resolve([]);
    await Promise.all([first, second]);
    expect(calls.filter((c) => c === 'a')).toHaveLength(1);
  });

  it('survives a failure to list suppliers or a failing poll', async () => {
    const handle = startSupplierPollLoops({
      logger,
      startImmediately: false,
      listSupplierIds: async () => {
        throw new Error('db down');
      },
    });
    handles.push(handle);
    await expect(handle.runOnce()).resolves.toBeUndefined();

    const failing = startSupplierPollLoops({
      logger,
      startImmediately: false,
      listSupplierIds: async () => ['a'],
      pollSupplier: async () => {
        throw new Error('supplier down');
      },
    });
    handles.push(failing);
    await expect(failing.runOnce()).resolves.toBeUndefined();
  });
});

describe('startSupplierOrderPlacerLoop', () => {
  it('does not start a pass while one is still running', async () => {
    const pass = deferred<[]>();
    const run = vi.fn(() => pass.promise);
    const handle = startSupplierOrderPlacerLoop({ logger, startImmediately: false, run });
    handles.push(handle);

    const first = handle.runOnce();
    const second = handle.runOnce();
    pass.resolve([]);
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps running after a pass throws', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue([]);
    const handle = startSupplierOrderPlacerLoop({ logger, startImmediately: false, run });
    handles.push(handle);
    await handle.runOnce();
    await handle.runOnce();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
