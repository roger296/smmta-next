/**
 * Signed one-click unsubscribe tokens (SPEC §12.3 unsubscribe link). HMAC over
 * the user id with UNSUBSCRIBE_SECRET — no DB lookup needed to verify, and the
 * link can't be forged.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env.js';

function sign(userId: string): string {
  return createHmac('sha256', getEnv().UNSUBSCRIBE_SECRET).update(userId).digest('hex');
}

export function unsubscribeToken(userId: string): string {
  return sign(userId);
}

export function unsubscribeUrl(userId: string): string {
  const base = getEnv().APP_BASE_URL;
  return `${base}/api/v1/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;
}

export function verifyUnsubscribe(userId: string, token: string): boolean {
  const expected = sign(userId);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
