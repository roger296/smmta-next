/**
 * Unit tests for `deriveMinRequestIntervalMs` — the single source of
 * truth for how supplier-row rate-limit columns turn into the
 * connector's inter-request delay.
 *
 * The derivation is small but operator-facing: a wrong answer here
 * either hammers the supplier (429s) or wastes throughput.
 */
import { describe, expect, it } from 'vitest';
import { deriveMinRequestIntervalMs } from './types.js';

describe('deriveMinRequestIntervalMs', () => {
  it('returns undefined when nothing is set', () => {
    expect(deriveMinRequestIntervalMs({})).toBeUndefined();
    expect(
      deriveMinRequestIntervalMs({
        minRequestIntervalMs: null,
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
      }),
    ).toBeUndefined();
  });

  it('honours the explicit override when set', () => {
    expect(
      deriveMinRequestIntervalMs({ minRequestIntervalMs: 1234 }),
    ).toBe(1234);
  });

  it('rounds the explicit override up (always integer)', () => {
    expect(
      deriveMinRequestIntervalMs({ minRequestIntervalMs: 1234.4 }),
    ).toBe(1235);
  });

  it('treats 0 / negative override as "not set"', () => {
    expect(deriveMinRequestIntervalMs({ minRequestIntervalMs: 0 })).toBeUndefined();
    expect(deriveMinRequestIntervalMs({ minRequestIntervalMs: -5 })).toBeUndefined();
  });

  it('derives from the rate-limit pair with 10% safety headroom', () => {
    // 10 req / 60 s ⇒ 6000 ms base × 1.1 = 6600 ms.
    expect(
      deriveMinRequestIntervalMs({
        rateLimitRequests: 10,
        rateLimitWindowSeconds: 60,
      }),
    ).toBe(6600);
  });

  it('handles other window sizes', () => {
    // 100 req / 60 s ⇒ 600 ms × 1.1 = 660 ms
    expect(
      deriveMinRequestIntervalMs({
        rateLimitRequests: 100,
        rateLimitWindowSeconds: 60,
      }),
    ).toBe(660);
    // 5 req / 10 s ⇒ 2000 ms × 1.1 = 2200 ms
    expect(
      deriveMinRequestIntervalMs({
        rateLimitRequests: 5,
        rateLimitWindowSeconds: 10,
      }),
    ).toBe(2200);
  });

  it('always rounds up (no rate-limit-by-floor)', () => {
    // 7 req / 60 s ⇒ 8571.43 ms × 1.1 = 9428.57 → ceil 9429
    expect(
      deriveMinRequestIntervalMs({
        rateLimitRequests: 7,
        rateLimitWindowSeconds: 60,
      }),
    ).toBe(9429);
  });

  it('override wins over the rate-limit pair', () => {
    expect(
      deriveMinRequestIntervalMs({
        minRequestIntervalMs: 1000,
        rateLimitRequests: 10,
        rateLimitWindowSeconds: 60,
      }),
    ).toBe(1000);
  });

  it('needs BOTH rate-limit fields to derive (single value → undefined)', () => {
    expect(
      deriveMinRequestIntervalMs({ rateLimitRequests: 10 }),
    ).toBeUndefined();
    expect(
      deriveMinRequestIntervalMs({ rateLimitWindowSeconds: 60 }),
    ).toBeUndefined();
  });

  it('rejects zero / negative values on the rate-limit pair', () => {
    expect(
      deriveMinRequestIntervalMs({ rateLimitRequests: 0, rateLimitWindowSeconds: 60 }),
    ).toBeUndefined();
    expect(
      deriveMinRequestIntervalMs({ rateLimitRequests: 10, rateLimitWindowSeconds: 0 }),
    ).toBeUndefined();
    expect(
      deriveMinRequestIntervalMs({ rateLimitRequests: -1, rateLimitWindowSeconds: 60 }),
    ).toBeUndefined();
  });
});
