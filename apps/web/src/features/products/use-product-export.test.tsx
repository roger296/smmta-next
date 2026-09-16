import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { fallbackExportFilename, useProductExport } from './use-product-export';

const API = 'http://localhost:8080/api/v1';
const CSV = 'Name,Stock code\r\nPlain Flour,FLOUR-01\r\n';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** What the browser was actually asked to download. */
let downloaded: { filename: string; href: string } | null = null;
let revoked: string[] = [];

beforeEach(() => {
  downloaded = null;
  revoked = [];
  // jsdom implements neither of these, and the download is useless without
  // them — but they must be added TO the real URL, not stubbed over it: the
  // API client calls `new URL(...)` to build every request path, so replacing
  // the global breaks every test in this file with "URL is not a constructor".
  URL.createObjectURL = vi.fn(() => 'blob:fake-url');
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded = { filename: this.download, href: this.href };
  });
  localStorage.setItem('smmta_token', 'test-token');
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function csvHandler(headers: Record<string, string> = {}) {
  return http.get(`${API}/products/export.csv`, () =>
    HttpResponse.text(CSV, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', ...headers },
    }),
  );
}

describe('useProductExport', () => {
  it('downloads the file under the name the server supplied', async () => {
    server.use(
      csvHandler({ 'Content-Disposition': 'attachment; filename="products-2026-09-16.csv"' }),
    );
    const { result } = renderHook(() => useProductExport(), { wrapper: wrapper() });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(downloaded?.filename).toBe('products-2026-09-16.csv');
  });

  it('falls back to a dated name when the server sends no filename', async () => {
    server.use(csvHandler());
    const { result } = renderHook(() => useProductExport(), { wrapper: wrapper() });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(downloaded?.filename).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('releases the object URL, so repeated exports do not leak the file', async () => {
    server.use(csvHandler());
    const { result } = renderHook(() => useProductExport(), { wrapper: wrapper() });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(revoked).toContain('blob:fake-url');
  });

  it('sends the bearer token — an unauthenticated download just 401s', async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get(`${API}/products/export.csv`, ({ request }) => {
        seenAuth = request.headers.get('Authorization');
        return HttpResponse.text(CSV, { headers: { 'Content-Type': 'text/csv' } });
      }),
    );
    const { result } = renderHook(() => useProductExport(), { wrapper: wrapper() });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(seenAuth).toBe('Bearer test-token');
  });

  it('surfaces the API error message rather than a bare status code', async () => {
    server.use(
      http.get(`${API}/products/export.csv`, () =>
        HttpResponse.json({ success: false, error: 'Catalogue is locked' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useProductExport(), { wrapper: wrapper() });
    result.current.mutate();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('Catalogue is locked');
    expect(downloaded).toBeNull();
  });
});

describe('fallbackExportFilename', () => {
  it('is dated', () => {
    expect(fallbackExportFilename(new Date('2026-09-16T10:03:00Z'))).toBe('products-2026-09-16.csv');
  });
});
