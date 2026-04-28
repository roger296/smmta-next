/**
 * Unit tests for the signed cookie helpers. Pure functions — no DOM, no
 * cookies(). The Next `cookies()` wrappers are exercised by the route
 * handler tests where they actually do something.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  process.env.STORE_COOKIE_SECRET = 'test-secret-just-for-vitest-32bytes-min';
});

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

describe('signCartId / verifyCartId', () => {
  it('round-trips a valid uuid', async () => {
    const { signCartId, verifyCartId } = await import('./cookies');
    const signed = signCartId(VALID_UUID);
    expect(signed).toMatch(new RegExp(`^${VALID_UUID}\\.[A-Za-z0-9_-]+$`));
    expect(verifyCartId(signed)).toBe(VALID_UUID);
  });

  it('rejects a tampered cart id', async () => {
    const { signCartId, verifyCartId } = await import('./cookies');
    const signed = signCartId(VALID_UUID);
    const dot = signed.indexOf('.');
    // Mutate one character of the uuid portion. Sig stays the same → fails.
    const tampered = signed.slice(0, 0) + '22222222-2222-4333-8444-555555555555' + signed.slice(dot);
    expect(verifyCartId(tampered)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const { signCartId, verifyCartId } = await import('./cookies');
    const signed = signCartId(VALID_UUID);
    const tampered = signed.slice(0, -1) + (signed.slice(-1) === 'A' ? 'B' : 'A');
    expect(verifyCartId(tampered)).toBeNull();
  });

  it('rejects a value with no separator', async () => {
    const { verifyCartId } = await import('./cookies');
    expect(verifyCartId(VALID_UUID)).toBeNull();
  });

  it('rejects null / undefined / empty', async () => {
    const { verifyCartId } = await import('./cookies');
    expect(verifyCartId(null)).toBeNull();
    expect(verifyCartId(undefined)).toBeNull();
    expect(verifyCartId('')).toBeNull();
  });

  it('rejects a uuid that does not match the canonical shape', async () => {
    const { signCartId, verifyCartId } = await import('./cookies');
    const signed = signCartId(VALID_UUID);
    const tampered = 'not-a-uuid' + signed.slice(VALID_UUID.length);
    expect(verifyCartId(tampered)).toBeNull();
  });

  it('different secrets produce different signatures (key isolation)', async () => {
    const { signCartId } = await import('./cookies');
    const sigA = signCartId(VALID_UUID);

    vi.resetModules();
    process.env.STORE_COOKIE_SECRET = 'completely-different-32byte-secret-x';
    const { signCartId: signB, verifyCartId: verifyB } = await import('./cookies');
    const sigB = signB(VALID_UUID);

    expect(sigA).not.toBe(sigB);
    expect(verifyB(sigA)).toBeNull(); // Cookie signed with key A doesn't verify under key B.
  });
});
