import { afterAll, describe, expect, it } from 'vitest';
import { resetBucket, takeTokens } from './rate-limit.js';

const BUCKET = 'test-rl';
afterAll(() => resetBucket(BUCKET));

describe('token bucket', () => {
  it('holds one minute of sends and refills per whole minute', async () => {
    const t0 = new Date('2026-11-05T10:00:00Z');
    await resetBucket(BUCKET);
    expect(await takeTokens(50, 600, t0, BUCKET)).toBe(10);
    expect(await takeTokens(50, 600, new Date(t0.getTime() + 30_000), BUCKET)).toBe(0);
    expect(await takeTokens(50, 600, new Date(t0.getTime() + 60_000), BUCKET)).toBe(10);
    // Idle for an hour: still one minute's worth, never a burst of 600.
    expect(await takeTokens(1000, 600, new Date(t0.getTime() + 3_660_000), BUCKET)).toBe(10);
  });

  it('never grants more than it has to 20 parallel takers', async () => {
    const t0 = new Date('2026-11-05T11:00:00Z');
    await resetBucket(BUCKET, 10, t0);
    const grants = await Promise.all(Array.from({ length: 20 }, () => takeTokens(1, 600, t0, BUCKET)));
    expect(grants.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('accumulates fractional refills', async () => {
    const t0 = new Date('2026-11-05T12:00:00Z');
    await resetBucket(BUCKET, 0, t0);
    // 30 an hour = half a token a minute.
    expect(await takeTokens(5, 30, new Date(t0.getTime() + 60_000), BUCKET)).toBe(0);
    expect(await takeTokens(5, 30, new Date(t0.getTime() + 120_000), BUCKET)).toBe(1);
  });
});
