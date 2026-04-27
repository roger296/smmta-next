/**
 * Unit tests for the api-key crypto helpers (no DB).
 */
import { describe, expect, it } from 'vitest';
import {
  KEY_PREFIX_LENGTH,
  KEY_SECRET_LENGTH,
  generateApiKey,
  hashSecret,
  parseRawKey,
  verifySecret,
} from './api-key.js';

describe('generateApiKey', () => {
  it('produces a key in the documented format', () => {
    const { raw, prefix, secret } = generateApiKey();
    expect(raw).toMatch(/^smmta_[0-9a-f]{8}_[0-9a-f]{32}$/);
    expect(prefix).toHaveLength(KEY_PREFIX_LENGTH);
    expect(secret).toHaveLength(KEY_SECRET_LENGTH);
    expect(raw).toBe(`smmta_${prefix}_${secret}`);
  });

  it('produces unique keys', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.secret).not.toBe(b.secret);
  });
});

describe('parseRawKey', () => {
  it('parses a well-formed key', () => {
    const { raw, prefix, secret } = generateApiKey();
    const parsed = parseRawKey(raw);
    expect(parsed).toEqual({ prefix, secret });
  });

  it('rejects malformed keys', () => {
    expect(parseRawKey('')).toBeNull();
    expect(parseRawKey('not-a-key')).toBeNull();
    expect(parseRawKey('smmta_short_key')).toBeNull();
    expect(parseRawKey('smmta_12345678_NOT_HEX_NOT_HEX_NOT_HEX_NOT_HEX_NO')).toBeNull();
    // Wrong prefix length
    expect(parseRawKey('smmta_1234567_12345678901234567890123456789012')).toBeNull();
    // Missing the leading namespace
    expect(parseRawKey('12345678_12345678901234567890123456789012')).toBeNull();
  });
});

describe('hashSecret + verifySecret', () => {
  it('verifies the same secret it was hashed with', async () => {
    const { secret } = generateApiKey();
    const hash = await hashSecret(secret);
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    await expect(verifySecret(secret, hash)).resolves.toBe(true);
  });

  it('rejects a different secret', async () => {
    const a = generateApiKey().secret;
    const b = generateApiKey().secret;
    const hash = await hashSecret(a);
    await expect(verifySecret(b, hash)).resolves.toBe(false);
  });

  it('produces different hashes for the same secret (random salt)', async () => {
    const { secret } = generateApiKey();
    const h1 = await hashSecret(secret);
    const h2 = await hashSecret(secret);
    expect(h1).not.toBe(h2);
    await expect(verifySecret(secret, h1)).resolves.toBe(true);
    await expect(verifySecret(secret, h2)).resolves.toBe(true);
  });

  it('rejects malformed stored hashes safely (no throw)', async () => {
    await expect(verifySecret('x', '')).resolves.toBe(false);
    await expect(verifySecret('x', 'no-colon')).resolves.toBe(false);
    await expect(verifySecret('x', ':onlyhash')).resolves.toBe(false);
    await expect(verifySecret('x', 'onlysalt:')).resolves.toBe(false);
    await expect(verifySecret('x', 'zz:zz')).resolves.toBe(false); // invalid hex
  });
});
