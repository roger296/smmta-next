/**
 * Port-selection tests for `getLlmPort()`.
 *
 * The regression these exist for: `getLlmPort()` used to fall back to
 * `FakeLlm` whenever OPENROUTER_API_KEY was empty — including in
 * production. FakeLlm only replays turns a test enqueued, so on a real
 * deploy its first call threw "FakeLlm: no scripted turn left" and the
 * storefront chat returned a bare {"error":"internal"} on every single
 * message while session creation kept working. The fix routes the
 * no-key non-test case to a port that throws a typed
 * LlmUnavailableError instead, so the misconfiguration is legible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeLlm,
  LlmUnavailableError,
  getLlmPort,
  isLlmConfigured,
  resetLlmPortForTests,
} from './index.js';
import * as envModule from '../../config/env.js';

type EnvShape = ReturnType<typeof envModule.getEnv>;

/** Stub getEnv() with only the fields the port selector reads. */
function stubEnv(overrides: { NODE_ENV?: string; OPENROUTER_API_KEY?: string }) {
  vi.spyOn(envModule, 'getEnv').mockReturnValue({
    NODE_ENV: overrides.NODE_ENV ?? 'production',
    OPENROUTER_API_KEY: overrides.OPENROUTER_API_KEY ?? '',
  } as unknown as EnvShape);
}

beforeEach(() => {
  resetLlmPortForTests();
});
afterEach(() => {
  resetLlmPortForTests();
  vi.restoreAllMocks();
});

describe('getLlmPort — port selection', () => {
  it('uses FakeLlm under NODE_ENV=test', () => {
    stubEnv({ NODE_ENV: 'test', OPENROUTER_API_KEY: '' });
    expect(getLlmPort()).toBeInstanceOf(FakeLlm);
  });

  it('NEVER uses FakeLlm in production, even with no API key', () => {
    stubEnv({ NODE_ENV: 'production', OPENROUTER_API_KEY: '' });
    const port = getLlmPort();
    expect(port).not.toBeInstanceOf(FakeLlm);
  });

  it('production + no API key → complete() throws LlmUnavailableError', async () => {
    stubEnv({ NODE_ENV: 'production', OPENROUTER_API_KEY: '' });
    const port = getLlmPort();
    await expect(
      port.complete({ model: 'anything', messages: [] }),
    ).rejects.toThrow(LlmUnavailableError);
  });

  it('development + no API key also refuses rather than faking', async () => {
    stubEnv({ NODE_ENV: 'development', OPENROUTER_API_KEY: '' });
    const port = getLlmPort();
    expect(port).not.toBeInstanceOf(FakeLlm);
    await expect(
      port.complete({ model: 'anything', messages: [] }),
    ).rejects.toThrow(LlmUnavailableError);
  });

  it('production + API key → real OpenRouter client (not the fake)', () => {
    stubEnv({ NODE_ENV: 'production', OPENROUTER_API_KEY: 'sk-or-test-key' });
    const port = getLlmPort();
    expect(port).not.toBeInstanceOf(FakeLlm);
    // The real client exposes complete() and holds the key internally.
    expect(typeof port.complete).toBe('function');
  });

  it('memoises the port across calls', () => {
    stubEnv({ NODE_ENV: 'test' });
    expect(getLlmPort()).toBe(getLlmPort());
  });
});

describe('isLlmConfigured', () => {
  it('true under test regardless of key', () => {
    stubEnv({ NODE_ENV: 'test', OPENROUTER_API_KEY: '' });
    expect(isLlmConfigured()).toBe(true);
  });
  it('false in production with no key', () => {
    stubEnv({ NODE_ENV: 'production', OPENROUTER_API_KEY: '' });
    expect(isLlmConfigured()).toBe(false);
  });
  it('true in production with a key', () => {
    stubEnv({ NODE_ENV: 'production', OPENROUTER_API_KEY: 'sk-or-x' });
    expect(isLlmConfigured()).toBe(true);
  });
});

describe('LlmUnavailableError', () => {
  it('names the missing variable in its message', () => {
    const err = new LlmUnavailableError();
    expect(err.name).toBe('LlmUnavailableError');
    expect(err.message).toMatch(/OPENROUTER_API_KEY/);
  });
});
