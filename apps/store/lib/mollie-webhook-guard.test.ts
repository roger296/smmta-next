/**
 * Guards the guard.
 *
 * A check meant to catch "Mollie cannot reach a localhost webhook" was gated on
 * NODE_ENV === 'production'. Next's standalone server hardcodes
 * `process.env.NODE_ENV = 'production'` (see .next/standalone/.../server.js),
 * so the e2e suite — which legitimately runs against a mock Mollie on
 * 127.0.0.1 — tripped it, and every checkout test timed out waiting for a
 * redirect that never came.
 *
 * The condition that actually matters is whether the REAL Mollie has to reach
 * us, so that is what these pin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REAL = 'https://api.mollie.com/v2/';

async function loadUsesLive(baseUrl: string | undefined) {
  vi.resetModules();
  if (baseUrl === undefined) delete process.env.MOLLIE_API_BASE_URL;
  else process.env.MOLLIE_API_BASE_URL = baseUrl;
  // MOLLIE_BASE is resolved at module load, so re-import per case.
  const mod = await import('./mollie');
  return mod.usesLiveMollieApi();
}

describe('usesLiveMollieApi', () => {
  const saved = process.env.MOLLIE_API_BASE_URL;
  beforeEach(() => {
    process.env.MOLLIE_API_KEY ||= 'test_key_for_module_load';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MOLLIE_API_BASE_URL;
    else process.env.MOLLIE_API_BASE_URL = saved;
    vi.resetModules();
  });

  it('is true when no override is set (production default)', async () => {
    expect(await loadUsesLive(undefined)).toBe(true);
  });

  it('is true for the real Mollie base', async () => {
    expect(await loadUsesLive(REAL)).toBe(true);
  });

  it('is false for the e2e mock on localhost', async () => {
    // Exactly what .github/workflows/e2e.yml sets.
    expect(await loadUsesLive('http://127.0.0.1:4000/v2/')).toBe(false);
  });

  it('is false for any other local or stubbed base', async () => {
    expect(await loadUsesLive('http://localhost:4000/v2/')).toBe(false);
    expect(await loadUsesLive('http://mollie-mock:4000/v2/')).toBe(false);
  });
});
