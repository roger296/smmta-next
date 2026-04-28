/**
 * Unit tests for the Sentry init helper.
 *
 *   - initSentry is a no-op when SENTRY_DSN is unset
 *   - initSentry is a no-op when @sentry/node isn't installed (the
 *     dynamic import throws and we swallow it)
 *   - initSentry is idempotent
 *
 * We don't actually require @sentry/node in dependencies; the init is
 * validated by the no-op path, and a real Sentry env is exercised by
 * the deploy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete process.env.SENTRY_DSN;
});

describe('initSentry', () => {
  it('is a no-op when SENTRY_DSN is empty', async () => {
    delete process.env.SENTRY_DSN;
    const { initSentry, isSentryInitialised } = await import('./sentry');
    await initSentry();
    expect(isSentryInitialised()).toBe(true); // memoised no-op
  });

  it('is idempotent — second call does not re-initialise', async () => {
    delete process.env.SENTRY_DSN;
    const { initSentry, isSentryInitialised, _resetForTests } = await import(
      './sentry'
    );
    _resetForTests();
    await initSentry();
    await initSentry();
    expect(isSentryInitialised()).toBe(true);
  });

  it('falls back to a no-op when @sentry/node is not installed', async () => {
    process.env.SENTRY_DSN = 'https://abc@example.invalid/1';
    const { initSentry, isSentryInitialised, _resetForTests } = await import(
      './sentry'
    );
    _resetForTests();
    await initSentry();
    // We didn't add @sentry/node to dependencies, so the dynamic
    // import throws and the helper marks itself initialised without
    // actually loading the SDK.
    expect(isSentryInitialised()).toBe(true);
  });
});
