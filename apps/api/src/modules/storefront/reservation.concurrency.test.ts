/**
 * Concurrency stress test for ReservationService.
 *
 * Iterates 100 times: seed exactly 1 IN_STOCK row, fire 50 parallel
 * `createReservation` calls for quantity 1. Asserts that exactly one
 * call succeeds and the other 49 throw `InsufficientStockError`.
 * If `FOR UPDATE SKIP LOCKED` isn't doing its job, this either
 * over-allocates (multiple successes) or deadlocks (no progress).
 *
 * The Prompt 15 brief calls for 50 parallel callers and 100 iterations
 * — that's the spec the underlying `FOR UPDATE SKIP LOCKED` query
 * needs to satisfy under realistic last-unit contention.
 *
 * The test single-threadedly drives the iteration loop but each
 * iteration's 50 calls run truly in parallel via `Promise.allSettled`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../config/database.js';
import { InsufficientStockError, ReservationService } from './reservation.service.js';
import {
  countStockByStatus,
  seedStockFor,
  wipeCompany,
} from '../../../test/fixtures/stock.js';

const COMPANY_ID = '66666666-6666-4666-8666-666666666666';
const ITERATIONS = 100;
const PARALLEL_CALLS = 50;

const service = new ReservationService();

afterAll(async () => {
  await wipeCompany(COMPANY_ID);
  await closeDatabase();
});

describe(`createReservation race for the last unit (${ITERATIONS}x)`, () => {
  it(
    `exactly one of ${PARALLEL_CALLS} parallel callers wins, ${ITERATIONS} iterations`,
    async () => {
      let totalSuccesses = 0;
      let totalFailures = 0;

      for (let i = 0; i < ITERATIONS; i++) {
        const fx = await seedStockFor(COMPANY_ID, 1);

        const calls = Array.from({ length: PARALLEL_CALLS }, () =>
          service.createReservation(COMPANY_ID, {
            items: [{ productId: fx.productId, quantity: 1 }],
            ttlSeconds: 900,
          }),
        );
        const results = await Promise.allSettled(calls);

        const successes = results.filter((r) => r.status === 'fulfilled');
        const failures = results.filter((r) => r.status === 'rejected');

        // Exactly one winner.
        expect(successes).toHaveLength(1);
        // The rest must be InsufficientStockError specifically — any other
        // error (deadlock, transient connection, schema mismatch) would
        // show up here and fail the test.
        expect(failures).toHaveLength(PARALLEL_CALLS - 1);
        for (const f of failures) {
          if (f.status !== 'rejected') continue;
          const err = f.reason as Error;
          if (!(err instanceof InsufficientStockError)) {
            throw new Error(
              `Iteration ${i}: unexpected failure "${err.name}: ${err.message}"`,
            );
          }
        }

        // Stock must be in a consistent state: 0 IN_STOCK, 1 RESERVED.
        const counts = await countStockByStatus(COMPANY_ID, fx.productId);
        expect(counts).toEqual({ IN_STOCK: 0, RESERVED: 1, ALLOCATED: 0 });

        totalSuccesses += successes.length;
        totalFailures += failures.length;
      }

      expect(totalSuccesses).toBe(ITERATIONS);
      expect(totalFailures).toBe(ITERATIONS * (PARALLEL_CALLS - 1));
    },
    // 100 iterations × 50 parallel transactions each will run for 30-60s
    // on a local Postgres + a few seconds longer in CI; the timeout is
    // generous on purpose so a slow CI runner doesn't false-positive.
    300_000,
  );
});
