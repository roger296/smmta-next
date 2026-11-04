import { eq } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { domainEvents } from '../../../db/schema/index.js';

/** Event-driven jobs receive `{ eventId, eventType }`; this reads the event's
 *  payload. Undefined when the event is gone. */
export async function eventPayload<T>(data: unknown): Promise<T | undefined> {
  const { eventId } = (data ?? {}) as { eventId?: string };
  if (!eventId) return undefined;
  const [row] = await getDb().select({ payload: domainEvents.payload }).from(domainEvents).where(eq(domainEvents.id, eventId)).limit(1);
  return row?.payload as T | undefined;
}
