/**
 * /api/email/subscribe — SMMTA is mocked; checks the body forwarded to
 * `subscribeEmail`, the 400 on bad input and the generic failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const subscribeEmail = vi.fn();
vi.mock('@/lib/smmta', () => ({ subscribeEmail }));
vi.mock('@/lib/log', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { POST } = await import('./route');
const { NEWSLETTER_SIGNUP_COPY } = await import('@/lib/email-copy');

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/email/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  subscribeEmail.mockReset();
  subscribeEmail.mockResolvedValue({ ok: true });
});

describe('POST /api/email/subscribe', () => {
  it('forwards the address, interests, wording, IP and user agent', async () => {
    const res = await POST(
      jsonRequest(
        { email: 'maker@example.com', interests: ['material:pla', 'material:petg'] },
        { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'TestAgent/1.0' },
      ) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(subscribeEmail).toHaveBeenCalledWith({
      email: 'maker@example.com',
      interests: ['material:pla', 'material:petg'],
      wording: NEWSLETTER_SIGNUP_COPY,
      ip: '203.0.113.9',
      userAgent: 'TestAgent/1.0',
    });
  });

  it('accepts a plain form post', async () => {
    const form = new URLSearchParams();
    form.set('email', 'maker@example.com');
    form.append('interests', 'material:tpu');
    const res = await POST(
      new Request('http://localhost/api/email/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(subscribeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'maker@example.com', interests: ['material:tpu'] }),
    );
  });

  it('defaults interests to none', async () => {
    const res = await POST(jsonRequest({ email: 'maker@example.com' }) as never);
    expect(res.status).toBe(200);
    expect(subscribeEmail).toHaveBeenCalledWith(expect.objectContaining({ interests: [] }));
  });

  it('rejects an invalid email with 400 and does not call SMMTA', async () => {
    const res = await POST(jsonRequest({ email: 'not-an-email', interests: [] }) as never);
    expect(res.status).toBe(400);
    expect(subscribeEmail).not.toHaveBeenCalled();
  });

  it('returns a generic error when SMMTA fails', async () => {
    subscribeEmail.mockRejectedValue(new Error('upstream exploded: address already exists'));
    const res = await POST(jsonRequest({ email: 'maker@example.com', interests: [] }) as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'subscribe_failed' });
  });
});
