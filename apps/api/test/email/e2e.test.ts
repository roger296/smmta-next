/**
 * The email system end to end (runbook section 13), on the test database.
 */
import { describe, expect, it } from 'vitest';
import { runEmailE2E } from '../../src/modules/email/e2e-flow.js';

describe('email end to end (sandbox)', () => {
  it('backfill → imports → digest → webhook → automations → report', async () => {
    const r = await runEmailE2E();
    expect(r.imports.bounces!.created).toBe(1);
    expect(r.imports.spam_reports!.created).toBe(1);
    expect(r.imports.unsubscribes!.created).toBe(1);
    expect(r.imports.contacts!.created).toBe(2);
    expect(r.statuses.bounced).toEqual({ marketingStatus: 'transactional_only', deliverability: 'hard_bounce' });
    expect(r.statuses.complainer).toEqual({ marketingStatus: 'transactional_only', deliverability: 'complained' });
    expect(r.statuses.unsub!.marketingStatus).toBe('transactional_only');
    expect(r.statuses.fan!.marketingStatus).toBe('all');
    expect(r.statuses.customer!.marketingStatus).toBe('transactional_only');
    // Only the two contacts who accept marketing get the digest.
    expect(r.digestSent).toBe(2);
    expect(r.events.stored).toBe(3);
    expect(r.report).toMatchObject({ sent: 2, delivered: 2, clicked: 1 });
    expect(r.automations.map((a) => a.key)).toEqual(['replenishment', 'abandoned_cart', 'welcome', 'post_purchase', 'winback', 'subscription', 'price_drop']);
  });
});
