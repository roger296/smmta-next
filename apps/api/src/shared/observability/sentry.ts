/**
 * Sentry init behind an env flag (SPEC §6). Kept dependency-free so the build
 * needs no @sentry package until an operator opts in: when SENTRY_ENABLED=true
 * and a DSN is set, this is where the real SDK is initialised. Until then it is
 * a no-op that records intent in the logs. Called from the API app and the
 * worker bootstrap.
 */
import { getEnv } from '../../config/env.js';

let initialised = false;

export function initSentry(component: 'api' | 'worker'): void {
  if (initialised) return;
  initialised = true;
  const env = getEnv();
  if (!env.SENTRY_ENABLED || !env.SENTRY_DSN) return;
  // Real init would go here, e.g.:
  //   import * as Sentry from '@sentry/node';
  //   Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, serverName: component });
  // eslint-disable-next-line no-console
  console.log(`[sentry] enabled for ${component} (DSN present) — install @sentry/node to activate`);
}
