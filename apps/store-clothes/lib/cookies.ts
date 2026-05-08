/**
 * Signed-cookie helpers for the cart_id cookie.
 *
 * Cookie value format:   `<uuid>.<base64url(hmacSha256(uuid))>`
 *
 * The cart_id is a uuid that maps to a row in `carts`. We HMAC-sign it
 * with `STORE_COOKIE_SECRET` so a customer can't tamper with the value
 * to take over someone else's cart. Verification is constant-time.
 *
 * Server-only — guarded so client components can't import these helpers
 * (and accidentally pull `cookies()` into a bundle).
 */
import 'server-only';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { cookies as nextCookies } from 'next/headers';
import { getEnv } from './env';

export const CART_COOKIE = 'cart_id';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function hmac(value: string): string {
  return createHmac('sha256', getEnv().STORE_COOKIE_SECRET)
    .update(value)
    .digest('base64url');
}

/** Sign a raw cart UUID into the value we drop in the cookie. */
export function signCartId(cartId: string): string {
  return `${cartId}.${hmac(cartId)}`;
}

/** Verify a signed cookie value, returning the raw cart UUID or `null`. */
export function verifyCartId(signed: string | undefined | null): string | null {
  if (!signed || typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot <= 0 || dot === signed.length - 1) return null;
  const id = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  // Sanity-check the id shape before HMAC'ing — saves a hash on garbage.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const expected = hmac(id);
  // Equal-length safeguard so timingSafeEqual doesn't throw.
  if (expected.length !== sig.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch {
    return null;
  }
  return id;
}

export function newCartId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Cookie I/O — wrappers around Next's `cookies()` helper. These exist so
// route handlers and server components can share one set of defaults.
// ---------------------------------------------------------------------------

export interface CartCookieOptions {
  /** Override Secure / SameSite for tests / dev tunnels. */
  secure?: boolean;
}

/** Read the verified cart UUID from the request cookie, or null. */
export async function readCartIdFromCookie(): Promise<string | null> {
  const store = await nextCookies();
  return verifyCartId(store.get(CART_COOKIE)?.value);
}

/** Write the signed cart cookie. Caller already has the raw UUID. */
export async function writeCartCookie(
  rawCartId: string,
  options: CartCookieOptions = {},
): Promise<void> {
  const store = await nextCookies();
  const isProd = process.env.NODE_ENV === 'production';
  store.set(CART_COOKIE, signCartId(rawCartId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure ?? isProd,
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

/** Clear the cart cookie (used after order commit). */
export async function clearCartCookie(): Promise<void> {
  const store = await nextCookies();
  store.delete(CART_COOKIE);
}
