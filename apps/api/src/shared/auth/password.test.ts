/**
 * Unit tests for password hashing.
 */
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('hashPassword + verifyPassword', () => {
  it('round-trips a plain password', async () => {
    const stored = await hashPassword('correct-horse-battery-staple');
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(await verifyPassword('correct-horse-battery-staple', stored)).toBe(true);
  });

  it('produces a different hash on every call (random salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('hunter2');
    expect(await verifyPassword('hunter3', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('rejects a tampered hash', async () => {
    const stored = await hashPassword('hunter2');
    const tampered = stored.slice(0, -2) + (stored.endsWith('00') ? '11' : '00');
    expect(await verifyPassword('hunter2', tampered)).toBe(false);
  });

  it('rejects a malformed stored value', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', ':')).toBe(false);
    expect(await verifyPassword('x', 'abc:')).toBe(false);
    expect(await verifyPassword('x', ':abc')).toBe(false);
  });

  it('throws on an empty input to hashPassword', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });
});
