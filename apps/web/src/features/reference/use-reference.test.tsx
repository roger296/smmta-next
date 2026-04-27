import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { useCategories, useWarehouses, useManufacturers } from './use-reference';

const API = 'http://localhost:8080/api/v1';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('reference data hooks', () => {
  it('useWarehouses fetches and unwraps', async () => {
    server.use(
      http.get(`${API}/warehouses`, () =>
        HttpResponse.json({
          success: true,
          data: [{ id: '1', name: 'W1', isDefault: true }],
        }),
      ),
    );
    const { result } = renderHook(() => useWarehouses(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.name).toBe('W1');
  });

  it('useCategories forwards search param', async () => {
    let seen: string | null = null;
    server.use(
      http.get(`${API}/categories`, ({ request }) => {
        const url = new URL(request.url);
        seen = url.searchParams.get('search');
        return HttpResponse.json({ success: true, data: [] });
      }),
    );
    const { result } = renderHook(() => useCategories('widgets'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(seen).toBe('widgets');
  });

  it('useManufacturers returns empty array on success', async () => {
    server.use(
      http.get(`${API}/manufacturers`, () =>
        HttpResponse.json({ success: true, data: [] }),
      ),
    );
    const { result } = renderHook(() => useManufacturers(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});
