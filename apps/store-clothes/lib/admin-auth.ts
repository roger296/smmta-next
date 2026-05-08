/**
 * Interim admin auth — one operator account, gated by `ADMIN_API_KEY`.
 *
 *   POST /api/admin/login   { key }    → sets the `admin_session` cookie
 *   POST /api/admin/logout              → clears it
 *   middleware.ts gates everything under /admin/* and /api/admin/*
 *
 * The cookie value is just a constant-time-comparable HMAC of "ok"
 * with `ADMIN_API_KEY` as the secret. Operators with the key can
 * mint the cookie themselves; without it no value the browser sends
 * will verify. This is intentionally simple — a real auth provider
 * (single-sign-on, audit log, MFA) is a follow-up; for v1 the storefront
 * has one operator and a key, and that's enough to gate refunds.
 *
 * Server-only.
 */
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies as nextCookies } from 'next/headers';
import { getEnv } from './env';

export const ADMIN_COOKIE = 'admin_session';
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8h working day

function hmacOk(): string {
  return createHmac('sha256', getEnv().ADMIN_API_KEY).update('ok').digest('base64url');
}

export function signAdminCookieValue(): string {
  return hmacOk();
}

export function verifyAdminCookieValue(value: string | undefined | null): boolean {
  if (!value) return false;
  if (!getEnv().ADMIN_API_KEY) return false;
  const expected = hmacOk();
  if (expected.length !== value.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(value));
  } catch {
    return false;
  }
}

/** Constant-time check the operator's typed key against the env key. */
export function verifyAdminKey(submitted: string): boolean {
  const expected = getEnv().ADMIN_API_KEY;
  if (!expected) return false;
  if (submitted.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function readAdminAuthCookie(): Promise<boolean> {
  const store = await nextCookies();
  return verifyAdminCookieValue(store.get(ADMIN_COOKIE)?.value);
}

export async function writeAdminCookie(): Promise<void> {
  const store = await nextCookies();
  const isProd = process.env.NODE_ENV === 'production';
  store.set(ADMIN_COOKIE, signAdminCookieValue(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function clearAdminCookie(): Promise<void> {
  const store = await nextCookies();
  store.delete(ADMIN_COOKIE);
}

/**
 * Request-side check that's safe to call from middleware. We can't
 * import `next/headers` from middleware (different runtime); instead
 * the middleware reads the cookie directly off `request.cookies`.
 */
export function verifyAdminRequestCookie(rawCookieValue: string | undefined): boolean {
  return verifyAdminCookieValue(rawCookieValue);
}
