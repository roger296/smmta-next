import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { useCustomersList } from './use-customers';

const API = 'http://localhost:8080/api/v1';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useCustomersList', () => {
  it('returns empty list from default handler', async () => {
    const { result } = renderHook(() => useCustomersList(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toEqual([]);
    expect(result.current.data?.total).toBe(0);
  });

  it('forwards search param as query string', async () => {
    let seenSearch: string | null = null;
    server.use(
      http.get(`${API}/customers`, ({ request }) => {
        const url = new URL(request.url);
        seenSearch = url.searchParams.get('search');
        return HttpResponse.json({
          success: true,
          data: [{ id: '1', name: 'Acme', email: null, code: null }],
          total: 1,
          page: 1,
          pageSize: 50,
          totalPages: 1,
        });
      }),
    );
    const { result } = renderHook(() => useCustomersList({ search: 'acme' }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(seenSearch).toBe('acme');
    expect(result.current.data?.data[0]?.name).toBe('Acme');
  });

  it('exposes error state on 500', async () => {
    server.use(
      http.get(`${API}/customers`, () =>
        HttpResponse.json({ success: false, error: 'DB down' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useCustomersList(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('DB down');
  });
});
