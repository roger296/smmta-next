/**
 * Unit tests for the admin auth surface — verifyAdminKey + the cookie
 * sign/verify pair. Pure crypto — no DB, no Next request mocking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REAL_KEY = 'b'.repeat(48);

beforeEach(() => {
  vi.resetModules();
  process.env.ADMIN_API_KEY = REAL_KEY;
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

describe('verifyAdminKey', () => {
  it('returns true on an exact match', async () => {
    const { verifyAdminKey } = await import('./admin-auth');
    expect(verifyAdminKey(REAL_KEY)).toBe(true);
  });

  it('returns false on a wrong-but-equal-length key', async () => {
    const { verifyAdminKey } = await import('./admin-auth');
    expect(verifyAdminKey('a'.repeat(48))).toBe(false);
  });

  it('returns false on a length mismatch (no timing leak)', async () => {
    const { verifyAdminKey } = await import('./admin-auth');
    expect(verifyAdminKey('short')).toBe(false);
  });

  it('returns false when ADMIN_API_KEY is unset', async () => {
    delete process.env.ADMIN_API_KEY;
    const { verifyAdminKey } = await import('./admin-auth');
    expect(verifyAdminKey('anything')).toBe(false);
  });
});

describe('signAdminCookieValue / verifyAdminCookieValue', () => {
  it('sign produces a verifiable value', async () => {
    const { signAdminCookieValue, verifyAdminCookieValue } = await import('./admin-auth');
    const v = signAdminCookieValue();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/); // base64url-ish
    expect(verifyAdminCookieValue(v)).toBe(true);
  });

  it('rejects a tampered value', async () => {
    const { signAdminCookieValue, verifyAdminCookieValue } = await import('./admin-auth');
    const v = signAdminCookieValue();
    // Flip one character — same length, different content.
    const flipped = `${v.slice(0, -1)}${v.slice(-1) === 'a' ? 'b' : 'a'}`;
    expect(verifyAdminCookieValue(flipped)).toBe(false);
  });

  it('rejects undefined / empty', async () => {
    const { verifyAdminCookieValue } = await import('./admin-auth');
    expect(verifyAdminCookieValue(undefined)).toBe(false);
    expect(verifyAdminCookieValue(null)).toBe(false);
    expect(verifyAdminCookieValue('')).toBe(false);
  });

  it('different ADMIN_API_KEY mints a different cookie', async () => {
    const { signAdminCookieValue: signA } = await import('./admin-auth');
    const a = signA();
    // env is memoised inside lib/env, so we have to reset modules to pick
    // up a different ADMIN_API_KEY for the same process.
    vi.resetModules();
    process.env.ADMIN_API_KEY = 'c'.repeat(48);
    const { signAdminCookieValue: signB } = await import('./admin-auth');
    const b = signB();
    expect(b).not.toBe(a);
  });
});
