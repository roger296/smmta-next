/**
 * Worker bootstrap (SPEC §4.1, §12).
 *
 * `startWorker` is the whole worker in one call: it starts pg-boss, creates
 * every queue (handlers + scheduled scanners + dead-letter), installs the
 * Prompt-1 stub handlers, wires pg-boss workers, schedules the crons, and
 * starts the outbox dispatch loop. `apps/worker` is a thin process that just
 * calls this. Everything lives here (next to the schema + db) rather than in
 * `apps/worker` so it shares one typecheck/test unit with the API — see
 * BUILD_LOG entry 1 for the adaptation vs THE SPEC's `apps/worker` sketch.
 */
import pino, { type Logger } from 'pino';
import { getBoss, startBoss, stopBoss } from './pgboss.js';
import {
  DEAD_LETTER_QUEUE,
  HANDLER_QUEUES,
  SCHEDULED_JOBS,
  retryPolicyFor,
} from './registry.js';
import { installStubHandlers, workQueue } from './handlers.js';
import { installFeatureHandlers } from './feature-handlers.js';
import { runDispatchLoop, type DispatchLoopHandle } from './dispatcher.js';

export { emitDomainEvent } from '../shared/events/index.js';
export { getBoss, startBoss, stopBoss } from './pgboss.js';
export { dispatchPending, dispatchOne, runDispatchLoop } from './dispatcher.js';
export { getRecentJobFailures } from './job-failures.js';
export {
  EVENT_HANDLERS,
  SCHEDULED_JOBS,
  HANDLER_QUEUES,
  DEAD_LETTER_QUEUE,
} from './registry.js';
export { setHandler, installStubHandlers } from './handlers.js';
export { initSentry } from '../shared/observability/sentry.js';
export { checkHealth } from '../modules/health/health.routes.js';

export function createWorkerLogger(): Logger {
  return pino({
    name: 'smmta-worker',
    level: process.env.LOG_LEVEL ?? 'info',
  });
}

export interface WorkerHandle {
  logger: Logger;
  stop: () => Promise<void>;
}

export interface StartWorkerOptions {
  logger?: Logger;
  dispatchIntervalMs?: number;
}

/**
 * Create every queue the worker needs. Idempotent (pg-boss upserts), so it is
 * safe on every boot. Handler queues carry their retry policy + shared
 * dead-letter; scheduled queues are plain.
 */
export async function setupQueues(): Promise<void> {
  const boss = getBoss();
  await boss.createQueue(DEAD_LETTER_QUEUE);
  for (const queue of HANDLER_QUEUES) {
    const { retryLimit, retryDelay } = retryPolicyFor(queue);
    // 'short' policy = unique index on (name, singleton_key) while a job is
    // still in the 'created' state. This is what makes the dispatcher's
    // `<eventId>:<queue>` singletonKey dedup a re-dispatch after a crash
    // between enqueue and processed_at commit — exactly-once handler fire.
    const opts = { name: queue, policy: 'short' as const, retryLimit, retryDelay, deadLetter: DEAD_LETTER_QUEUE };
    // createQueue is ON CONFLICT DO NOTHING, so an already-existing queue keeps
    // its old policy; updateQueue enforces the config idempotently on redeploy.
    await boss.createQueue(queue, opts);
    await boss.updateQueue(queue, opts);
  }
  for (const job of SCHEDULED_JOBS) {
    await boss.createQueue(job.name, { name: job.name });
  }
}

export async function startWorker(opts: StartWorkerOptions = {}): Promise<WorkerHandle> {
  const logger = opts.logger ?? createWorkerLogger();
  const boss = await startBoss();

  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));

  await setupQueues();
  // Real handlers first; stubs only fill the gaps for queues not yet implemented.
  installFeatureHandlers(logger);
  installStubHandlers(logger);

  // Wire a pg-boss worker for every handler + scheduled queue.
  for (const queue of HANDLER_QUEUES) await workQueue(boss, queue, logger);
  for (const job of SCHEDULED_JOBS) await workQueue(boss, job.name, logger);
  await workQueue(boss, DEAD_LETTER_QUEUE, logger.child({ dead_letter: true }));

  // Register the cron schedule for each scanner.
  for (const job of SCHEDULED_JOBS) {
    await boss.schedule(job.name, job.cron);
  }

  const loop: DispatchLoopHandle = runDispatchLoop(boss, {
    intervalMs: opts.dispatchIntervalMs,
    logger,
  });

  logger.info(
    { queues: HANDLER_QUEUES.length, scheduled: SCHEDULED_JOBS.length },
    'worker started',
  );

  return {
    logger,
    stop: async () => {
      loop.stop();
      await stopBoss();
      logger.info('worker stopped');
    },
  };
}
