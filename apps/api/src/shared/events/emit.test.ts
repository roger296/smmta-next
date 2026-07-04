/**
 * Unit/integration tests for emitDomainEvent + the handler registry.
 * Real Postgres at DATABASE_URL; no pg-boss (that's dispatcher.test.ts).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { domainEvents } from '../../db/schema/index.js';
import { emitDomainEvent } from './emit.js';
import { DOMAIN_EVENT_TYPES } from './types.js';
import { EVENT_HANDLERS, HANDLER_QUEUES, handlersFor } from '../../worker/registry.js';

const TEST_COMPANY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

async function countEvents(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(eq(domainEvents.companyId, TEST_COMPANY));
  return rows.length;
}

afterEach(async () => {
  const db = getDb();
  await db.delete(domainEvents).where(eq(domainEvents.companyId, TEST_COMPANY));
});

afterAll(async () => {
  await closeDatabase();
});

describe('emitDomainEvent — outbox semantics', () => {
  it('writes an event row inside a committed transaction', async () => {
    const db = getDb();
    const emitted = await db.transaction((tx) =>
      emitDomainEvent(tx, {
        eventType: 'shipment.eta_changed',
        aggregateType: 'shipment',
        aggregateId: '11111111-1111-4111-8111-111111111111',
        payload: { oldEta: '2026-08-01', newEta: '2026-08-10' },
        companyId: TEST_COMPANY,
      }),
    );
    expect(emitted.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.id, emitted.id), eq(domainEvents.companyId, TEST_COMPANY)));
    expect(row?.eventType).toBe('shipment.eta_changed');
    expect(row?.processedAt).toBeNull();
    expect(row?.payload).toMatchObject({ newEta: '2026-08-10' });
  });

  it('never persists an event when the transaction rolls back', async () => {
    const db = getDb();
    await expect(
      db.transaction(async (tx) => {
        await emitDomainEvent(tx, {
          eventType: 'order.placed',
          payload: { orderId: 'x' },
          companyId: TEST_COMPANY,
        });
        throw new Error('boom — business logic failed after emit');
      }),
    ).rejects.toThrow('boom');

    expect(await countEvents()).toBe(0);
  });
});

describe('handler registry', () => {
  it('every EVENT_HANDLERS key is a known event type and maps to known queues', () => {
    for (const [eventType, queues] of Object.entries(EVENT_HANDLERS)) {
      expect(DOMAIN_EVENT_TYPES).toContain(eventType);
      for (const q of queues ?? []) {
        expect(HANDLER_QUEUES).toContain(q);
      }
    }
  });

  it('handlersFor returns the mapped queues and [] for unmapped events', () => {
    expect(handlersFor('interest.flag_created')).toEqual(['threshold-check']);
    expect(handlersFor('stock.replenished')).toEqual(['back-in-stock-fanout']);
    expect(handlersFor('order.dispatched')).toEqual([]);
    expect(handlersFor('nonsense.event')).toEqual([]);
  });
});
