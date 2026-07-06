/**
 * Integration tests for the outbox dispatcher + pg-boss (SPEC §12.1, §12.3).
 * Real Postgres + real pg-boss at DATABASE_URL. Proves:
 *   (a) a committed event is dispatched exactly once, even across a restart
 *       and even across a crash between enqueue and commit (singletonKey);
 *   (b) an event from a rolled-back transaction is never dispatched;
 *   (c) a failing handler retries per policy and dead-letters after the limit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb, getPool } from '../config/database.js';
import { getEnv } from '../config/env.js';
import { domainEvents } from '../db/schema/index.js';
import { emitDomainEvent } from '../shared/events/emit.js';
import { getBoss, startBoss, stopBoss } from './pgboss.js';
import { setupQueues } from './index.js';
import { dispatchPending } from './dispatcher.js';
import { DEAD_LETTER_QUEUE } from './registry.js';

const TEST_COMPANY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const FLAG_EVENT = 'interest.flag_created'; // → 'threshold-check'
const HANDLER = 'threshold-check';

let boss: PgBoss;

/** Count queued (not-yet-completed) jobs directly from pg-boss's own tables —
 *  deterministic regardless of getQueueSize's default semantics. */
async function queued(name: string): Promise<number> {
  const schema = getEnv().PGBOSS_SCHEMA;
  const res = await getPool().query(
    `SELECT count(*)::int AS n FROM "${schema}".job WHERE name = $1 AND state IN ('created','retry')`,
    [name],
  );
  return res.rows[0].n as number;
}

async function emitFlag(): Promise<string> {
  const db = getDb();
  const { id } = await db.transaction((tx) =>
    emitDomainEvent(tx, {
      eventType: FLAG_EVENT,
      aggregateType: 'interest',
      aggregateId: '22222222-2222-4222-8222-222222222222',
      payload: { sku: 'PLA-BLACK', flagType: 'restock' },
      companyId: TEST_COMPANY,
    }),
  );
  return id;
}

async function eventProcessedAt(id: string): Promise<Date | null> {
  const db = getDb();
  const [row] = await db.select().from(domainEvents).where(eq(domainEvents.id, id));
  return row?.processedAt ?? null;
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor: condition not met within timeout');
}

beforeAll(async () => {
  boss = await startBoss();
  await setupQueues();
});

afterAll(async () => {
  await stopBoss();
  await closeDatabase();
});

beforeEach(async () => {
  const db = getDb();
  await db.delete(domainEvents).where(eq(domainEvents.companyId, TEST_COMPANY));
  await boss.purgeQueue(HANDLER);
  await boss.purgeQueue(DEAD_LETTER_QUEUE);
});

describe('outbox-dispatcher', () => {
  it('dispatches a committed event exactly once and marks it processed', async () => {
    const id = await emitFlag();

    const n = await dispatchPending(boss);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await queued(HANDLER)).toBe(1);
    expect(await eventProcessedAt(id)).not.toBeNull();

    // Restart: a second pass sees the event already processed → no re-enqueue.
    await dispatchPending(boss);
    expect(await queued(HANDLER)).toBe(1);
  });

  it('re-dispatch after a crash between enqueue and commit still enqueues exactly once', async () => {
    const id = await emitFlag();

    // Crash simulation: handlers enqueue, then throw before processed_at commits.
    await expect(
      dispatchPending(boss, {
        onAfterEnqueue: () => {
          throw new Error('crash between enqueue and commit');
        },
      }),
    ).rejects.toThrow('crash');

    // The job was enqueued (separate pg-boss connection committed it)...
    expect(await queued(HANDLER)).toBe(1);
    // ...but the event is still unprocessed (its update rolled back).
    expect(await eventProcessedAt(id)).toBeNull();

    // Restart, clean pass: the singletonKey prevents a duplicate enqueue.
    await dispatchPending(boss);
    expect(await queued(HANDLER)).toBe(1);
    expect(await eventProcessedAt(id)).not.toBeNull();
  });

  it('never dispatches an event whose emitting transaction rolled back', async () => {
    const db = getDb();
    await expect(
      db.transaction(async (tx) => {
        await emitDomainEvent(tx, {
          eventType: FLAG_EVENT,
          payload: { sku: 'X' },
          companyId: TEST_COMPANY,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const n = await dispatchPending(boss);
    expect(n).toBe(0);
    expect(await queued(HANDLER)).toBe(0);
  });

  it('retries a failing handler per policy then dead-letters it', async () => {
    const Q = 'test-failing-queue';
    await boss.createQueue(Q, {
      name: Q,
      retryLimit: 1,
      retryDelay: 0,
      deadLetter: DEAD_LETTER_QUEUE,
    });
    await boss.purgeQueue(Q);
    await boss.purgeQueue(DEAD_LETTER_QUEUE);

    let attempts = 0;
    await boss.work(Q, { pollingIntervalSeconds: 1 }, async (jobs) => {
      attempts += jobs.length;
      throw new Error('handler always fails');
    });

    const jobId = await boss.send(Q, { hello: 'world' });
    expect(jobId).toBeTruthy();

    // Wait until the original job is exhausted (failed) and dead-lettered.
    await waitFor(async () => (await queued(DEAD_LETTER_QUEUE)) >= 1);

    const job = await boss.getJobById(Q, jobId!, { includeArchive: true });
    expect(job?.state).toBe('failed');
    // initial attempt + retryLimit(1) retry = 2 invocations
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(await queued(DEAD_LETTER_QUEUE)).toBe(1);

    await boss.offWork(Q);
  });
});
