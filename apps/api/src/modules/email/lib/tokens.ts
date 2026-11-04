/**
 * Tokens (runbook section 2).
 *  - Unsubscribe: each contact's random `unsubscribe_token`, stored, so a
 *    link keeps working for as long as the contact exists and can be revoked
 *    by rotating it. Nothing is derived from the address.
 *  - Signed links (add-to-cart deep links): `<payload>.<sig>`, payload is
 *    base64url JSON with an expiry, sig is HMAC-SHA256 with EMAIL_TOKEN_SECRET.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { tokenSecret } from './config.js';

export function unsubscribeToken(contact: { unsubscribeToken: string }): string {
  return contact.unsubscribeToken;
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** A tamper-proof token carrying `payload`, valid for `ttlSeconds`. */
export function signedLink(payload: Record<string, unknown>, ttlSeconds = 30 * 86_400, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds })).toString(
    'base64url',
  );
  return `${body}.${sign(body, tokenSecret())}`;
}

/** The payload when the token is genuine and unexpired, else null. */
export function verifySignedLink<T extends Record<string, unknown>>(token: string, now = Date.now()): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body, tokenSecret()));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}
