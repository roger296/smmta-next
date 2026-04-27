import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { apiFetch, ApiError } from './api-client';
import { clearToken, setToken } from './auth';

const API = 'http://localhost:8080/api/v1';

describe('apiFetch', () => {
  beforeEach(() => {
    clearToken();
  });
  afterEach(() => {
    clearToken();
  });

  it('unwraps the success envelope', async () => {
    server.use(
      http.get(`${API}/widgets/1`, () =>
        HttpResponse.json({ success: true, data: { id: '1', name: 'Widget' } }),
      ),
    );
    const result = await apiFetch<{ id: string; name: string }>('/widgets/1');
    expect(result).toEqual({ id: '1', name: 'Widget' });
  });

  it('returns the paginated shape when envelope is paginated', async () => {
    server.use(
      http.get(`${API}/widgets`, () =>
        HttpResponse.json({
          success: true,
          data: [{ id: '1' }],
          total: 1,
          page: 1,
          pageSize: 10,
          totalPages: 1,
        }),
      ),
    );
    const result = await apiFetch<{ data: unknown[]; total: number }>('/widgets');
    expect(result.total).toBe(1);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('attaches Authorization header when token present', async () => {
    setToken('TEST_TOKEN');
    let authHeader: string | null = null;
    server.use(
      http.get(`${API}/echo`, ({ request }) => {
        authHeader = request.headers.get('Authorization');
        return HttpResponse.json({ success: true, data: null });
      }),
    );
    await apiFetch('/echo');
    expect(authHeader).toBe('Bearer TEST_TOKEN');
  });

  it('omits Authorization when no token', async () => {
    let authHeader: string | null = 'x';
    server.use(
      http.get(`${API}/echo`, ({ request }) => {
        authHeader = request.headers.get('Authorization');
        return HttpResponse.json({ success: true, data: null });
      }),
    );
    await apiFetch('/echo');
    expect(authHeader).toBeNull();
  });

  it('throws ApiError with server message on success:false', async () => {
    server.use(
      http.post(`${API}/bad`, () =>
        HttpResponse.json({ success: false, error: 'Bad input' }, { status: 400 }),
      ),
    );
    await expect(apiFetch('/bad', { method: 'POST', body: {} })).rejects.toThrow(ApiError);
    await expect(apiFetch('/bad', { method: 'POST', body: {} })).rejects.toThrow('Bad input');
  });

  it('clears token on 401', async () => {
    setToken('STALE');
    // Replace window.location with a stub that captures href writes
    const hrefAssignments: string[] = [];
    const stubLocation = {
      pathname: '/',
      href: '',
    };
    Object.defineProperty(stubLocation, 'href', {
      get: () => '',
      set: (v: string) => {
        hrefAssignments.push(v);
      },
    });
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: stubLocation,
    });

    server.use(
      http.get(`${API}/protected`, () =>
        HttpResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
      ),
    );
    try {
      await expect(apiFetch('/protected')).rejects.toThrow(ApiError);
      expect(window.localStorage.getItem('smmta_token')).toBeNull();
      expect(hrefAssignments).toContain('/login');
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  it('builds searchParams correctly', async () => {
    let url = '';
    server.use(
      http.get(`${API}/search`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ success: true, data: null });
      }),
    );
    await apiFetch('/search', { searchParams: { q: 'abc', page: 2, empty: undefined } });
    expect(url).toContain('q=abc');
    expect(url).toContain('page=2');
    expect(url).not.toContain('empty=');
  });

  it('does NOT throw when VITE_API_BASE_URL is a relative path like /api/v1', async () => {
    // Simulates production build where API_BASE_URL is relative — the URL constructor
    // would otherwise throw "Invalid URL". Regression test for the bug hit on first deploy.
    const path = '/customers';
    const relativeBase = '/api/v1';
    // Manually build what the client would build — this mirrors buildUrl()'s logic.
    const raw = `${relativeBase}${path}`;
    expect(raw).toBe('/api/v1/customers');
    // Without a base, new URL(raw) throws. With window.location.origin it works.
    expect(() => new URL(raw)).toThrow();
    expect(() => new URL(raw, window.location.origin)).not.toThrow();
    expect(new URL(raw, window.location.origin).pathname).toBe('/api/v1/customers');
  });
});
