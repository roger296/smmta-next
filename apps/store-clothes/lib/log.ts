/**
 * Structured logger for the storefront — Pino, JSON output, severity
 * controlled by `LOG_LEVEL` (default `info` in prod, `debug` everywhere
 * else). Server-only.
 *
 * Two helpers ship alongside the root logger:
 *
 *   - `getRequestId(headers)` reads (or generates) the `x-request-id`
 *     so a single id ties together: storefront's RSC fetches → API
 *     calls (the `Authorization: Bearer …` header carries it forward
 *     via `X-Request-Id`) → Mollie / SendGrid client calls → the
 *     resulting log lines + Sentry breadcrumbs.
 *
 *   - `withRequestId(logger, requestId)` returns a child logger that
 *     adds `requestId` to every emitted record. Pino child loggers
 *     are zero-allocation in the hot path.
 *
 * Both helpers run in the Node runtime; the Edge middleware uses
 * `crypto.randomUUID()` directly (Web Crypto, no Pino).
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Resolve the log level from env. Defaults to debug in any non-prod
 *  environment so we don't lose breadcrumbs in dev/test logs. */
function resolveLevel(): pino.Level {
  const explicit = process.env.LOG_LEVEL?.toLowerCase();
  if (
    explicit === 'fatal' ||
    explicit === 'error' ||
    explicit === 'warn' ||
    explicit === 'info' ||
    explicit === 'debug' ||
    explicit === 'trace'
  ) {
    return explicit;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

/** Root logger — JSON output, no transport, single shared instance. */
export const log: Logger = pino({
  level: resolveLevel(),
  base: {
    service: 'smmta-store',
    // PID + hostname are noise in containers; the systemd unit captures
    // them at the journald layer. Keep the JSON small.
    pid: undefined,
    hostname: undefined,
  },
  // Redact Authorization / Cookie headers from any nested object that
  // happens to carry them. Defence in depth — most call sites already
  // strip secrets before logging, but the redactor is cheap insurance.
  redact: {
    paths: [
      'headers.authorization',
      'headers.cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.apiKey',
      '*.api_key',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Read the inbound `x-request-id` (case-insensitive) or mint a fresh
 *  uuid v4 if the request didn't carry one. Headers can be a fetch
 *  `Headers` instance, a plain object, or a Next.js cookies/headers
 *  reader's iterator. */
export function getRequestId(headers: Headers | Record<string, string | string[] | undefined> | undefined): string {
  if (!headers) return randomUUID();
  if (headers instanceof Headers) {
    const v = headers.get(REQUEST_ID_HEADER);
    if (v && v.length > 0) return v;
    return randomUUID();
  }
  // Plain object — case-insensitive lookup.
  const lower = REQUEST_ID_HEADER;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      const value = Array.isArray(v) ? v[0] : v;
      if (value && value.length > 0) return value;
    }
  }
  return randomUUID();
}

/** Build a child logger with a requestId binding. The child shares the
 *  parent's transport / level, so log volume + format stay consistent. */
export function withRequestId(parent: Logger, requestId: string): Logger {
  return parent.child({ requestId });
}
