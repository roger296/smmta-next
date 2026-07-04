/**
 * Handler + scheduled-job stubs (SPEC §12.3).
 *
 * Prompt 1 registers every event-driven handler and every scheduled scanner as
 * a no-op that logs its invocation, so the queue/cron wiring is real and
 * observable end-to-end. Later prompts replace each stub with the real service
 * call (compose-message → OpenRouter, send-message → SendGrid, etc.).
 */
import type PgBoss from 'pg-boss';
import type { Logger } from 'pino';
import { HANDLER_QUEUES, SCHEDULED_JOBS } from './registry.js';

/**
 * Registry of live handler functions, keyed by queue name. Overridable so
 * later prompts can swap a stub for the real implementation without touching
 * the boot wiring, and so tests can inject a spy/failing handler.
 */
export type JobHandler = (data: unknown, logger: Logger) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/** Register (or replace) the handler for a queue. */
export function setHandler(queue: string, fn: JobHandler): void {
  handlers.set(queue, fn);
}

export function getHandler(queue: string): JobHandler | undefined {
  return handlers.get(queue);
}

/** Install the Prompt 1 no-op stubs for every handler + scheduled job. */
export function installStubHandlers(logger: Logger): void {
  for (const queue of HANDLER_QUEUES) {
    if (!handlers.has(queue)) {
      setHandler(queue, async (data) => {
        logger.info({ queue, data }, `[stub] handler ${queue} invoked`);
      });
    }
  }
  for (const job of SCHEDULED_JOBS) {
    if (!handlers.has(job.name)) {
      setHandler(job.name, async () => {
        logger.info({ job: job.name }, `[stub] scheduled job ${job.name} invoked`);
      });
    }
  }
}

/**
 * Wire a pg-boss worker for `queue` that dispatches each job through the live
 * handler registry (so a later hot-swap of the handler is picked up).
 */
export async function workQueue(boss: PgBoss, queue: string, logger: Logger): Promise<void> {
  await boss.work(queue, async (jobs) => {
    for (const job of jobs) {
      const fn = getHandler(queue);
      if (!fn) throw new Error(`no handler registered for queue ${queue}`);
      await fn(job.data, logger);
    }
  });
}

/** For tests: forget all registered handlers. */
export function resetHandlersForTests(): void {
  handlers.clear();
}
