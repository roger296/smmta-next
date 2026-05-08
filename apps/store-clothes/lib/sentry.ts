/**
 * Sentry integration — thin wrapper that the storefront server entry
 * points (route handlers, RSC pages, the standalone server.js) call
 * once at boot.
 *
 * Designed to be safe to call when Sentry isn't installed or the DSN
 * isn't set: in either case the helper no-ops and tests / dev runs
 * keep working. The Sentry Node SDK is loaded via a dynamic import so
 * the absence of `@sentry/node` in `dependencies` (until the operator
 * actually wants Sentry) doesn't break `npm install`.
 *
 * PII scrubbing is on by default — `sendDefaultPii: false` plus a
 * `beforeSend` hook that strips Authorization / Cookie headers and
 * obvious request-body keys. In practice the storefront passes only
 * server-trusted email + address through — but defence in depth.
 *
 * Server-only.
 */
import 'server-only';
import { getEnv } from './env';

/** Minimal Sentry surface area we depend on. We don't import
 *  `@sentry/node` directly so apps without the SDK installed still
 *  type-check; the runtime dynamic import below loads the real
 *  module when present. */
interface SentryLike {
  init(options: {
    dsn: string;
    environment?: string;
    tracesSampleRate?: number;
    sendDefaultPii?: boolean;
    beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null;
  }): void;
}

let initialised = false;

/** Initialise Sentry. Idempotent. Safe to call before logger setup. */
export async function initSentry(): Promise<void> {
  if (initialised) return;
  const env = getEnv();
  if (!env.SENTRY_DSN) {
    initialised = true; // memoise the no-op so we don't re-check every time
    return;
  }

  // Dynamic import so the SDK only has to be installed when Sentry is
  // actually being used. Cast through `unknown` because we don't
  // have @sentry/node in dependencies — the operator installs it on
  // production hosts where the DSN is set.
  let Sentry: SentryLike;
  try {
    const sentryModule: unknown = await import(
      /* webpackIgnore: true */ '@sentry/node' as string
    );
    Sentry = sentryModule as SentryLike;
  } catch {
    // SDK not installed — fall back to a no-op. This keeps the dev
    // experience friction-free; production deploys are expected to
    // have @sentry/node in node_modules.
    initialised = true;
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: Number.parseFloat(env.SENTRY_TRACES_SAMPLE_RATE),
    sendDefaultPii: false,
    beforeSend(event: Record<string, unknown>) {
      // Defensive scrub — the Sentry SDK already redacts a lot, but
      // we strip request headers that might carry creds or cookies
      // explicitly, plus form-body keys that look like secrets.
      const req = (event as { request?: { headers?: Record<string, string>; data?: unknown } })
        .request;
      if (req?.headers) {
        for (const key of Object.keys(req.headers)) {
          const lower = key.toLowerCase();
          if (lower === 'authorization' || lower === 'cookie' || lower === 'x-api-key') {
            req.headers[key] = '[REDACTED]';
          }
        }
      }
      if (req?.data && typeof req.data === 'object') {
        const d = req.data as Record<string, unknown>;
        for (const key of Object.keys(d)) {
          if (/password|secret|token|api[_-]?key/i.test(key)) {
            d[key] = '[REDACTED]';
          }
        }
      }
      return event;
    },
  });

  initialised = true;
}

/** Convenience for tests + the `instrumentation.ts` Next hook. */
export function isSentryInitialised(): boolean {
  return initialised;
}

/** Reset memo for tests only — never call from app code. */
export function _resetForTests(): void {
  initialised = false;
}
