/**
 * The sender's token bucket (runbook section 6). One row in
 * `email_rate_limit`; the bucket holds one minute's worth of sends
 * (hourly limit ÷ 60) and refills by that much each whole minute, so 600 an
 * hour goes out as 10 a minute rather than 600 at once. `take` is atomic: it
 * locks the row, so parallel workers can never overspend.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { emailRateLimit } from '../../../db/schema/index.js';

const MINUTE_MS = 60_000;

export async function takeTokens(want: number, perHour: number, now = new Date(), bucket = 'default'): Promise<number> {
  if (want <= 0) return 0;
  const perMinute = Math.max(perHour / 60, 0);
  const capacity = Math.max(perMinute, 1);
  return getDb().transaction(async (tx) => {
    await tx.insert(emailRateLimit).values({ id: bucket, tokens: capacity, refilledAt: now }).onConflictDoNothing();
    const [row] = await tx.select().from(emailRateLimit).where(eq(emailRateLimit.id, bucket)).for('update');
    const minutes = Math.floor((now.getTime() - row!.refilledAt.getTime()) / MINUTE_MS);
    let tokens = row!.tokens;
    let refilledAt = row!.refilledAt;
    if (minutes > 0) {
      tokens = Math.min(capacity, tokens + minutes * perMinute);
      refilledAt = new Date(refilledAt.getTime() + minutes * MINUTE_MS);
    }
    // Never more than a full bucket, whatever the clock did.
    tokens = Math.min(tokens, capacity);
    const granted = Math.max(0, Math.min(want, Math.floor(tokens + 1e-9)));
    await tx
      .update(emailRateLimit)
      .set({ tokens: tokens - granted, refilledAt })
      .where(eq(emailRateLimit.id, bucket));
    return granted;
  });
}

/** The bucket's state, for the Deliverability page. */
export async function bucketState(bucket = 'default') {
  const [row] = await getDb().select().from(emailRateLimit).where(eq(emailRateLimit.id, bucket));
  return row ?? null;
}

/** For tests. */
export async function resetBucket(bucket = 'default', tokens?: number, at = new Date()): Promise<void> {
  await getDb().delete(emailRateLimit).where(eq(emailRateLimit.id, bucket));
  if (tokens !== undefined) await getDb().insert(emailRateLimit).values({ id: bucket, tokens, refilledAt: at });
}
