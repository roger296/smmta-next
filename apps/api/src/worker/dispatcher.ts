/**
 * outbox-dispatcher (SPEC §12.1, §12.3, §13.8).
 *
 * Polls `domain_events` for unprocessed rows (partial index → O(pending)),
 * fans each out to its handler queues, and stamps `processed_at`. Crash-safe:
 *
 *  - Each event is claimed with `FOR UPDATE SKIP LOCKED`, so two dispatchers
 *    (or a dispatcher racing its own restart) never double-process one event.
 *  - Handler enqueue uses a `singletonKey` of `<eventId>:<queue>`. If the
 *    process crashes AFTER enqueue but BEFORE `processed_at` commits, the event
 *    stays unprocessed and is re-dispatched — the singletonKey makes the second
 *    enqueue a no-op, so the handler still fires exactly once.
 *  - Events written inside a rolled-back business transaction never exist, so
 *    they are never dispatched.
 */
import type PgBoss from 'pg-boss';
import type { Logger } from 'pino';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { domainEvents } from '../db/schema/index.js';
import { DEAD_LETTER_QUEUE, handlersFor, retryPolicyFor } from './registry.js';

export interface DispatchOptions {
  limit?: number;
  logger?: Logger;
  /**
   * Test seam: invoked after an event's handlers are enqueued but BEFORE its
   * `processed_at` is committed. Throwing here simulates a crash in exactly
   * that window, letting a test prove exactly-once across a "restart".
   */
  onAfterEnqueue?: (eventId: string) => void | Promise<void>;
}

/** Dispatch one event by id inside its own transaction. Returns true if it was
 *  claimed and processed, false if another worker held it / it was already done. */
export async function dispatchOne(
  boss: PgBoss,
  eventId: string,
  opts: DispatchOptions = {},
): Promise<boolean> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT id, event_type FROM domain_events
          WHERE id = ${eventId} AND processed_at IS NULL
          FOR UPDATE SKIP LOCKED`,
    );
    const row = (locked.rows as Array<{ id: string; event_type: string }>)[0];
    if (!row) return false;

    for (const queue of handlersFor(row.event_type)) {
      const { retryLimit, retryDelay } = retryPolicyFor(queue);
      await boss.send(
        queue,
        { eventId, eventType: row.event_type },
        {
          singletonKey: `${eventId}:${queue}`,
          retryLimit,
          retryDelay,
          deadLetter: DEAD_LETTER_QUEUE,
        },
      );
    }

    if (opts.onAfterEnqueue) await opts.onAfterEnqueue(eventId);

    await tx
      .update(domainEvents)
      .set({ processedAt: sql`now()` })
      .where(eq(domainEvents.id, eventId));
    return true;
  });
}

/** Poll a batch of unprocessed events and dispatch each. Returns the count
 *  actually processed this pass. */
export async function dispatchPending(boss: PgBoss, opts: DispatchOptions = {}): Promise<number> {
  const { limit = 100, logger } = opts;
  const db = getDb();

  const candidates = await db
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(isNull(domainEvents.processedAt))
    .orderBy(asc(domainEvents.createdAt))
    .limit(limit);

  let dispatched = 0;
  for (const { id } of candidates) {
    try {
      if (await dispatchOne(boss, id, opts)) dispatched++;
    } catch (err) {
      // A single bad event must not stall the whole outbox. Log and move on;
      // the row stays unprocessed and is retried next pass.
      logger?.error({ err, eventId: id }, 'outbox-dispatcher: failed to dispatch event');
      if (opts.onAfterEnqueue) throw err; // in tests we want the simulated crash to surface
    }
  }
  return dispatched;
}

export interface DispatchLoopHandle {
  stop: () => void;
}

/** Run the dispatcher on a ~10s interval (§12.3). Returns a handle to stop it. */
export function runDispatchLoop(
  boss: PgBoss,
  opts: { intervalMs?: number; logger?: Logger } = {},
): DispatchLoopHandle {
  const intervalMs = opts.intervalMs ?? 10_000;
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap passes
    running = true;
    try {
      await dispatchPending(boss, { logger: opts.logger });
    } catch (err) {
      opts.logger?.error({ err }, 'outbox-dispatcher: pass failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
