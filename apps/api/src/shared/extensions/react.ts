/**
 * How an extension reacts to a domain event.
 *
 * The core routes each event to the handler queues named in the worker
 * registry. An extension adds its own queue to that routing at start-up, from
 * its registerWorker(): the dispatcher then enqueues a job on that queue for
 * every such event, with the same exactly-once and retry behaviour the core's
 * handlers get, and the extension's function runs it.
 *
 *   registerWorker(logger) {
 *     reactToEvent('order.lines_changed', 'my_extension-lines-changed', async (eventId) => { ... }, logger);
 *   }
 *
 * The handler is given the event's id; read the event row for its payload, as
 * the core's handlers do, so a retry sees the same data.
 */
import type { Logger } from 'pino';
import { getDb } from '../../config/database.js';
import { domainEvents } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { DomainEventType } from '../events/types.js';
import { setHandler } from '../../worker/handlers.js';
import { registerReaction } from '../../worker/registry.js';

export interface ReactionEvent {
  id: string;
  eventType: string;
  companyId: string;
  payload: unknown;
}

export type ReactionHandler = (event: ReactionEvent, logger: Logger) => Promise<void>;

/**
 * Routes `eventType` to `queue` and installs `handler` for it. The queue name
 * must start with the extension's key, so two extensions never share one.
 */
export function reactToEvent(eventType: DomainEventType, queue: string, handler: ReactionHandler, logger: Logger): void {
  registerReaction(eventType, queue);
  setHandler(queue, async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (!eventId) return;
    const [event] = await getDb()
      .select({ id: domainEvents.id, eventType: domainEvents.eventType, companyId: domainEvents.companyId, payload: domainEvents.payload })
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    if (!event) return;
    await handler(event, logger);
  });
}
