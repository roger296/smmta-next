/**
 * Retry classification and provider-error capture.
 *
 * Written after three order confirmations failed and the only recorded reason
 * was the word "Forbidden" — SendGrid's ResponseError.message is just the HTTP
 * status text, while the sentence that actually names the problem lives in
 * response.body.errors and surfaces only via toString(). These pin both the
 * capture and the retry rules, since neither had any coverage.
 */
import { describe, expect, it } from 'vitest';
import { describeFailure, isRetryable, MAX_ATTEMPTS } from './email';

/** Mirrors @sendgrid/helpers' ResponseError closely enough to test against. */
class FakeResponseError extends Error {
  code: number;
  response: { headers: Record<string, string>; body: unknown };
  constructor(status: number, statusText: string, errors?: Array<Record<string, string>>) {
    super();
    this.code = status;
    this.message = statusText;
    this.response = { headers: {}, body: errors ? { errors } : {} };
  }
  toString() {
    const body = this.response.body as { errors?: Array<Record<string, string>> };
    let out = `${this.message} (${this.code})`;
    for (const e of body.errors ?? []) out += `\n  ${e.message}\n    ${e.field}\n    ${e.help}`;
    return out;
  }
}

describe('describeFailure', () => {
  it('keeps the sentence that names the problem, not just the status text', () => {
    const err = new FakeResponseError(403, 'Forbidden', [
      {
        message: 'The from address does not match a verified Sender Identity.',
        field: 'from',
        help: 'https://sendgrid.com/docs/for-developers/sending-email/sender-identity/',
      },
    ]);
    const d = describeFailure(err);
    expect(d.statusCode).toBe(403);
    // The old code stored err.message and produced exactly "Forbidden".
    expect(d.message).not.toBe('Forbidden');
    expect(d.message).toContain('verified Sender Identity');
    expect(d.retryable).toBe(false);
  });

  it('handles a plain Error with no provider response', () => {
    const d = describeFailure(new Error('socket hang up'));
    expect(d.statusCode).toBeNull();
    expect(d.message).toContain('socket hang up');
    expect(d.retryable).toBe(true); // never reached the provider — worth retrying
  });

  it('never yields an unhelpful [object Object]', () => {
    expect(describeFailure({ weird: true }).message).not.toBe('[object Object]');
  });
});

describe('isRetryable', () => {
  it('retries rate limits and provider outages', () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(503)).toBe(true);
  });

  it('does not retry a rejection of this specific message', () => {
    // Re-sending an identical request earns an identical refusal.
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(401)).toBe(false);
    expect(isRetryable(403)).toBe(false);
    expect(isRetryable(413)).toBe(false);
  });

  it('retries when the request never completed', () => {
    expect(isRetryable(null)).toBe(true);
  });
});

describe('MAX_ATTEMPTS', () => {
  it('is bounded, so a permanently broken row cannot loop for ever', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
