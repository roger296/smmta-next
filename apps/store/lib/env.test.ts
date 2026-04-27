/**
 * Smoke tests for the store env loader. Cheap to run, doesn't touch the
 * network. Verifies the defaults the rest of the app relies on.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('getEnv()', () => {
  beforeEach(() => {
    // The env module memoises its parse — reset between tests.
    vi.resetModules();
  });

  it('parses defaults when no env is set', async () => {
    delete process.env.SMMTA_API_BASE_URL;
    delete process.env.STORE_BASE_URL;
    const { getEnv } = await import('./env');
    const env = getEnv();
    // The default API host is 8080 (the storefront takes :3000).
    expect(env.SMMTA_API_BASE_URL).toMatch(/:8080\//);
    expect(env.STORE_BASE_URL).toMatch(/^http/);
    expect(env.NODE_ENV).toBeOneOf(['development', 'production', 'test']);
  });

  it('respects an explicit SMMTA_API_BASE_URL', async () => {
    process.env.SMMTA_API_BASE_URL = 'https://api.example.com/api/v1';
    const { getEnv } = await import('./env');
    expect(getEnv().SMMTA_API_BASE_URL).toBe('https://api.example.com/api/v1');
  });
});
