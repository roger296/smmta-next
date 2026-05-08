/**
 * Unit tests for the AES-256-GCM helper.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt, resetCryptoForTests } from './encrypt.js';

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_JWT = process.env.JWT_SECRET;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key-with-some-entropy-1234567890';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'jwt-secret-fallback';
  resetCryptoForTests();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  if (ORIGINAL_JWT === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT;
  resetCryptoForTests();
});

describe('encrypt / decrypt — AES-256-GCM', () => {
  it('round-trips a plain string', () => {
    const enc = encrypt('hunter2');
    expect(enc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decrypt(enc)).toBe('hunter2');
  });

  it('produces a different ciphertext on every call (random IV)', () => {
    const a = encrypt('same-plaintext');
    const b = encrypt('same-plaintext');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same-plaintext');
    expect(decrypt(b)).toBe('same-plaintext');
  });

  it('round-trips longer payloads with utf8 chars', () => {
    const big = 'API key — éàü — '.repeat(50);
    expect(decrypt(encrypt(big))).toBe(big);
  });

  it('throws on a tampered auth tag', () => {
    const enc = encrypt('secret');
    const [iv, tag, ct] = enc.split(':');
    const flippedTag =
      tag!.slice(0, -2) + (tag!.endsWith('00') ? 'ff' : '00');
    const tampered = `${iv}:${flippedTag}:${ct}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on a tampered ciphertext', () => {
    const enc = encrypt('secret');
    const [iv, tag, ct] = enc.split(':');
    const flippedCt =
      ct!.slice(0, -2) + (ct!.endsWith('00') ? 'ff' : '00');
    const tampered = `${iv}:${tag}:${flippedCt}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on a malformed envelope', () => {
    expect(() => decrypt('not-three-parts')).toThrow();
    expect(() => decrypt('a:b')).toThrow();
    expect(() => decrypt('a:b:c:d')).toThrow();
  });

  it('falls back to JWT_SECRET when ENCRYPTION_KEY is absent', () => {
    delete process.env.ENCRYPTION_KEY;
    process.env.JWT_SECRET = 'jwt-only-fallback';
    resetCryptoForTests();
    const enc = encrypt('payload');
    expect(decrypt(enc)).toBe('payload');
  });

  it('throws on empty plaintext', () => {
    expect(() => encrypt('')).toThrow();
  });

  it('throws when neither ENCRYPTION_KEY nor JWT_SECRET is set', () => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.JWT_SECRET;
    resetCryptoForTests();
    expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY/);
  });
});
