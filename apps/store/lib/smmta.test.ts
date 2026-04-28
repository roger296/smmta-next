/**
 * Unit tests for the typed SMMTA client. Mocks global fetch — no real
 * network. Verifies retry behaviour, terminal-error mapping, and the
 * Authorization header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub `next/headers` and request-scoped state — the smmta module imports
// `import 'server-only'` which is harmless under vitest because `test/setup.ts`
// already mocks it. The `next` fetch override (`{ next: { ... } }`) is
// silently ignored by the global fetch in node, which is what we want.

beforeEach(() => {
  vi.resetModules();
  process.env.SMMTA_API_BASE_URL = 'http://localhost:8080/api/v1';
  process.env.SMMTA_API_KEY = 'smmta_deadbeef_' + '0'.repeat(32);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface MockResponseInit {
  status?: number;
  body?: unknown;
}

function mockResponse({ status = 200, body }: MockResponseInit): Response {
  return new Response(body !== undefined ? JSON.stringify(body) : null, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('smmtaFetch retry behaviour', () => {
  it('returns data on first 200', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse({ body: { success: true, data: { hello: 'world' } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { smmtaFetch } = await import('./smmta');
    const result = await smmtaFetch<{ hello: string }>('storefront/groups');
    expect(result).toEqual({ hello: 'world' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx and succeeds on the 3rd attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(mockResponse({ status: 502 }))
      .mockResolvedValueOnce(
        mockResponse({ body: { success: true, data: { ok: true } } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { smmtaFetch } = await import('./smmta');
    const result = await smmtaFetch<{ ok: boolean }>('storefront/groups');
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws SmmtaApiError immediately on a 4xx (no retries)', async () => {
    // The default mock resolves on every call so the assertions can each
    // make a fresh request and inspect the same outcome.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ status: 404, body: { error: 'Not found' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { smmtaFetch, SmmtaApiError } = await import('./smmta');
    await expect(smmtaFetch('storefront/groups/missing')).rejects.toBeInstanceOf(
      SmmtaApiError,
    );
    await expect(smmtaFetch('storefront/groups/missing')).rejects.toMatchObject({
      status: 404,
    });
    // No retry on 4xx → 1 fetch call per smmtaFetch invocation.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after 4 attempts on persistent 5xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    const { smmtaFetch, SmmtaApiError } = await import('./smmta');
    await expect(smmtaFetch('storefront/groups')).rejects.toBeInstanceOf(SmmtaApiError);
    // Default DEFAULT_RETRIES is 3 → 1 initial + 3 retries = 4 attempts.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('attaches the Authorization Bearer header when SMMTA_API_KEY is set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ body: { success: true, data: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const { smmtaFetch } = await import('./smmta');
    await smmtaFetch('storefront/groups');
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer smmta_/,
    );
  });

  it('throws with parsed error body on a 422', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse({ status: 422, body: { error: 'Total mismatch', expected: '24.00' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { smmtaFetch, SmmtaApiError } = await import('./smmta');
    try {
      await smmtaFetch('storefront/orders');
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SmmtaApiError);
      const e = err as InstanceType<typeof SmmtaApiError>;
      expect(e.status).toBe(422);
      expect(e.message).toMatch(/Total mismatch/);
      expect(e.body).toMatchObject({ expected: '24.00' });
    }
  });
});
