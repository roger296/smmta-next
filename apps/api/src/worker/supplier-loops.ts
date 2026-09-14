/**
 * Drop-ship loops run inside the worker process.
 *
 * Plain setInterval loops rather than pg-boss crons, like the outbox
 * dispatcher: a Ralawise stock sweep runs for hours at 10 requests a minute,
 * far longer than a cron slot. Both loops are switched on by env flags
 * (SUPPLIER_POLL_ENABLED, SUPPLIER_ORDER_PLACING_ENABLED) in `startWorker`.
 */
import type { Logger } from 'pino';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { suppliers } from '../db/schema/index.js';
import { runSupplierPoll, type SupplierPollOutcome } from '../workers/supplier-poll.worker.js';
import { runSupplierOrderPlacer, type PlacerOutcome } from '../workers/supplier-order-placer.worker.js';

export interface SupplierLoopHandle {
  stop: () => void;
  /** Run one pass now and wait for it, including any polls it starts. */
  runOnce: () => Promise<void>;
}

export interface PlacerLoopOptions {
  logger: Logger;
  intervalMs?: number;
  /** Start a pass straight away (default) rather than after the first interval. */
  startImmediately?: boolean;
  run?: () => Promise<PlacerOutcome[]>;
}

/** Send PENDING supplier orders, one pass at a time. */
export function startSupplierOrderPlacerLoop(opts: PlacerLoopOptions): SupplierLoopHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  const run = opts.run ?? (() => runSupplierOrderPlacer());
  let running = false;

  const tick = async () => {
    if (running) return; // never overlap passes
    running = true;
    try {
      for (const outcome of await run()) {
        if (outcome.result === 'SKIPPED') continue;
        const log = outcome.result === 'FAILED' ? opts.logger.error.bind(opts.logger) : opts.logger.info.bind(opts.logger);
        log(outcome, 'supplier-order-placer: supplier order processed');
      }
    } catch (err) {
      opts.logger.error({ err }, 'supplier-order-placer: pass failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  if (opts.startImmediately !== false) void tick();
  return { stop: () => clearInterval(timer), runOnce: tick };
}

export interface PollLoopOptions {
  logger: Logger;
  intervalMs?: number;
  startImmediately?: boolean;
  listSupplierIds?: () => Promise<string[]>;
  pollSupplier?: (supplierId: string) => Promise<SupplierPollOutcome[]>;
}

/**
 * One lane per supplier. Uneek's whole-catalogue stock call takes seconds;
 * Ralawise's sweep takes hours. A shared loop would leave Uneek's stock
 * hours stale behind Ralawise, so each supplier polls on its own, and a
 * supplier still polling is not started again. Each supplier's own
 * `pollIntervalMinutes` decides when it next runs; this loop only checks.
 */
export function startSupplierPollLoops(opts: PollLoopOptions): SupplierLoopHandle {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const list = opts.listSupplierIds ?? listPollableSupplierIds;
  const poll =
    opts.pollSupplier ?? ((supplierId: string) => runSupplierPoll({ onlySupplierId: supplierId, respectCadence: true }));
  const inFlight = new Map<string, Promise<void>>();

  const tick = async (): Promise<Promise<void>[]> => {
    let ids: string[];
    try {
      ids = await list();
    } catch (err) {
      opts.logger.error({ err }, 'supplier-poll: could not list suppliers');
      return [];
    }
    const started: Promise<void>[] = [];
    for (const supplierId of ids) {
      if (inFlight.has(supplierId)) continue;
      const lane = poll(supplierId)
        .then((outcomes) => {
          for (const o of outcomes) {
            if (o.skippedBecause) continue;
            const log = o.errorMessage ? opts.logger.warn.bind(opts.logger) : opts.logger.info.bind(opts.logger);
            log(o, 'supplier-poll: supplier polled');
          }
        })
        .catch((err: unknown) => {
          opts.logger.error({ err, supplierId }, 'supplier-poll: poll failed');
        })
        .finally(() => {
          inFlight.delete(supplierId);
        });
      inFlight.set(supplierId, lane);
      started.push(lane);
    }
    return started;
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  if (opts.startImmediately !== false) void tick();
  return {
    stop: () => clearInterval(timer),
    runOnce: async () => {
      await Promise.all(await tick());
    },
  };
}

/** Suppliers with a connector that are taking drop-ship orders. */
export async function listPollableSupplierIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.isDropshipActive, true),
        ne(suppliers.connectorKind, 'NONE'),
        isNull(suppliers.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}
