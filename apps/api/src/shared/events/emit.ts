/**
 * emitDomainEvent — the ONLY way the API writes to the outbox (SPEC §4.3, §12.1).
 *
 * It takes a Drizzle transaction handle (not the root db) so an event can only
 * ever be written INSIDE the same transaction as the business change it
 * records. If that transaction rolls back, the event is never visible to the
 * dispatcher — the outbox guarantee. Callers must already be inside
 * `db.transaction(async (tx) => { ... emitDomainEvent(tx, ...) })`.
 */
import type { getDb } from '../../config/database.js';
import { domainEvents } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../auth/company.js';
import type { EmitDomainEventInput } from './types.js';

type Db = ReturnType<typeof getDb>;

/**
 * A Drizzle transaction handle. Deriving it from the `transaction` callback
 * parameter means it always tracks the real driver type, and it is distinct
 * from the root `Db`, so passing a non-transactional handle is discouraged at
 * the type level.
 */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function emitDomainEvent(
  tx: DbTx,
  input: EmitDomainEventInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(domainEvents)
    .values({
      companyId: input.companyId ?? getSingletonCompanyId(),
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload,
    })
    .returning({ id: domainEvents.id });

  if (!row) throw new Error('emitDomainEvent: insert returned no row');
  return row;
}
