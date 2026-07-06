/**
 * Mollie factory. Returns the in-memory fake when no MOLLIE_API_KEY is set or
 * NODE_ENV=test (so the app boots + tests run without credentials); otherwise
 * the real TEST-mode client. Tests may inject a fake via setMollieForTests.
 */
import { getEnv } from '../../config/env.js';
import type { MolliePort } from './mollie.types.js';
import { MollieClient } from './mollie.client.js';
import { FakeMollie } from './mollie.fake.js';

let _mollie: MolliePort | undefined;

export function getMollie(): MolliePort {
  if (!_mollie) {
    const env = getEnv();
    if (env.NODE_ENV === 'test' || !env.MOLLIE_API_KEY) {
      _mollie = new FakeMollie();
    } else {
      _mollie = new MollieClient(env.MOLLIE_API_KEY);
    }
  }
  return _mollie;
}

/** Inject a specific port (tests). */
export function setMollieForTests(port: MolliePort): void {
  _mollie = port;
}

export function resetMollieForTests(): void {
  _mollie = undefined;
}

export * from './mollie.types.js';
export { FakeMollie } from './mollie.fake.js';
export { MollieClient } from './mollie.client.js';
