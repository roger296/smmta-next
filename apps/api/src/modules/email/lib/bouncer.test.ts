/**
 * Bouncer client against recorded-style fixtures: each status, a timeout, a
 * 429 and a 500, and a batch. Every request goes to the stubbed fetch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BouncerClient, BouncerError } from './bouncer.js';

const fx = (name: string) => readFileSync(resolve(process.cwd(), `test/fixtures/email/bouncer/${name}.json`), 'utf8');
const client = () => new BouncerClient({ apiKey: 'test-key', baseUrl: 'https://bouncer.test/v1.1', sleep: async () => undefined, pollIntervalMs: 1 });

afterEach(() => vi.unstubAllGlobals());

describe('BouncerClient.verify', () => {
  it.each(['deliverable', 'undeliverable', 'risky', 'unknown'])('reads a %s result', async (status) => {
    const fetchMock = vi.fn(async () => new Response(fx(status), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await client().verify('someone@example.com');
    expect(r.status).toBe(status);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://bouncer.test/v1.1/email/verify?email=someone%40example.com&timeout=10');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
  });

  it('treats a timeout as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }));
    await expect(client().verify('a@example.com')).rejects.toMatchObject({ retryable: true });
  });

  it('treats 429 and 500 as retryable and 401 as permanent', async () => {
    for (const [status, retryable] of [[429, true], [500, true], [401, false]] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
      const err = await client().verify('a@example.com').catch((e) => e);
      expect(err).toBeInstanceOf(BouncerError);
      expect(err.retryable).toBe(retryable);
    }
  });

  it('refuses to run without a key and never sends one it does not have', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const c = new BouncerClient({ apiKey: '' });
    expect(c.configured).toBe(false);
    await expect(c.verify('a@example.com')).rejects.toMatchObject({ retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('BouncerClient.verifyBatch', () => {
  it('creates a batch, polls until complete and downloads the results', async () => {
    const calls: string[] = [];
    let polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url.replace('https://bouncer.test/v1.1', '')}`);
        if (url.endsWith('/email/verify/batch')) return new Response(JSON.stringify({ batchId: 'b1', status: 'queued' }));
        if (url.endsWith('/batch/b1')) return new Response(JSON.stringify({ status: ++polls < 3 ? 'processing' : 'completed' }));
        return new Response(JSON.stringify([JSON.parse(fx('deliverable')), JSON.parse(fx('undeliverable'))]));
      }),
    );
    const out = await client().verifyBatch(['good@example.com', 'gone@example.com']);
    expect(out.map((r) => r.status)).toEqual(['deliverable', 'undeliverable']);
    expect(calls).toEqual([
      'POST /email/verify/batch',
      'GET /email/verify/batch/b1',
      'GET /email/verify/batch/b1',
      'GET /email/verify/batch/b1',
      'GET /email/verify/batch/b1/download?download=all',
    ]);
  });
});
