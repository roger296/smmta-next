/**
 * Luca is an optional integration, and the way it fails matters.
 *
 * `post()` re-throws on failure so the caller's transaction rolls back. That is
 * the right call when Luca is genuinely in use — a stock movement and its
 * journal entry should not diverge. But it means that with no Luca instance
 * reachable, every stock adjustment and GRN 500s and rolls back, which is how
 * this deployment ended up unable to book in any stock at all.
 *
 * Worse, the FAILED log row is written inside that same transaction, so the
 * rollback discards it too — the gl_posting_log retry trail the design relies
 * on never actually records the failure.
 *
 * These tests pin the disabled path: no client call, no DB write, no throw.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { LucaGLService } from './luca-gl.service.js';
import { resetEnvForTests } from '../../config/env.js';

/** Fails loudly if the service touches the DB or the client while disabled. */
function explodingDb() {
  return new Proxy({}, {
    get() {
      throw new Error('DB must not be touched when LUCA_ENABLED is false');
    },
  });
}

const explodingClient = {
  postTransaction: async () => {
    throw new Error('Luca must not be called when LUCA_ENABLED is false');
  },
} as never;

describe('LucaGLService when Luca is not enabled', () => {
  const prev = process.env.LUCA_ENABLED;

  beforeEach(() => {
    process.env.LUCA_ENABLED = 'false';
    resetEnvForTests();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LUCA_ENABLED;
    else process.env.LUCA_ENABLED = prev;
    resetEnvForTests();
  });

  it('skips a stock adjustment posting without calling Luca or writing a log', async () => {
    const svc = new LucaGLService(explodingClient);
    const id = await svc.postStockAdjustment(explodingDb() as never, {
      companyId: '11111111-1111-4111-8111-111111111111',
      adjustmentId: '22222222-2222-4222-8222-222222222222',
      adjustmentDate: new Date('2026-08-26T00:00:00Z'),
      stockValue: 46.2,
      type: 'ADD',
      productName: 'Landau PLA 1.75mm 1kg — Green',
    });
    // Empty string is the existing "nothing posted" signal (see stockValue <= 0).
    expect(id).toBe('');
  });

  it('does not throw, so the caller\u2019s transaction is free to commit', async () => {
    const svc = new LucaGLService(explodingClient);
    await expect(
      svc.postStockAdjustment(explodingDb() as never, {
        companyId: '11111111-1111-4111-8111-111111111111',
        adjustmentId: '33333333-3333-4333-8333-333333333333',
        adjustmentDate: new Date('2026-08-26T00:00:00Z'),
        stockValue: 10,
        type: 'REMOVE',
        productName: 'Anything',
      }),
    ).resolves.toBe('');
  });
});
