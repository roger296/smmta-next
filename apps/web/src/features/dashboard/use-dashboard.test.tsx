import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { useDashboardKpis } from './use-dashboard';

const API = 'http://localhost:3000/api/v1';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useDashboardKpis', () => {
  it('aggregates open orders, stock value, unpaid invoices, unpaid bills', async () => {
    server.use(
      http.get(`${API}/orders`, () =>
        HttpResponse.json({
          success: true,
          data: [
            {
              id: '1',
              status: 'CONFIRMED',
              total: '100.00',
              currencyCode: 'GBP',
              customerId: 'c1',
              customerName: 'A',
              orderDate: '2026-04-01',
              orderNumber: 'ORD-1',
            },
            {
              id: '2',
              status: 'COMPLETED',
              total: '50.00',
              currencyCode: 'GBP',
              customerId: 'c1',
              customerName: 'A',
              orderDate: '2026-04-02',
              orderNumber: 'ORD-2',
            },
          ],
          total: 2,
          page: 1,
          pageSize: 20,
          totalPages: 1,
        }),
      ),
      http.get(`${API}/invoices`, () =>
        HttpResponse.json({
          success: true,
          data: [
            { id: 'i1', status: 'ISSUED', outstandingAmount: '150.00' },
            { id: 'i2', status: 'ISSUED', outstandingAmount: '250.00' },
          ],
          total: 2,
          page: 1,
          pageSize: 100,
          totalPages: 1,
        }),
      ),
      http.get(`${API}/supplier-invoices`, () =>
        HttpResponse.json({
          success: true,
          data: [
            { id: 'b1', status: 'ISSUED', outstandingAmount: '300.00' },
            { id: 'b2', status: 'PAID', outstandingAmount: '0.00' },
          ],
          total: 2,
          page: 1,
          pageSize: 100,
          totalPages: 1,
        }),
      ),
      http.get(`${API}/stock-items/report`, () =>
        HttpResponse.json({
          success: true,
          data: [
            { totalValue: '500.00' },
            { totalValue: '1000.00' },
          ],
        }),
      ),
    );

    const { result } = renderHook(() => useDashboardKpis(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const data = result.current.data!;
    expect(data.openOrdersCount).toBe(1); // Only CONFIRMED counts as open
    expect(data.openOrdersValue).toBe(100);
    expect(data.stockValue).toBe(1500);
    expect(data.unpaidInvoicesTotal).toBe(400);
    expect(data.unpaidBillsTotal).toBe(300); // Paid bill excluded
    expect(data.recentOrders).toHaveLength(2);
  });

  it('gracefully handles failing sub-queries', async () => {
    server.use(
      http.get(`${API}/orders`, () =>
        HttpResponse.json({
          success: true,
          data: [],
          total: 0,
          page: 1,
          pageSize: 20,
          totalPages: 0,
        }),
      ),
      http.get(`${API}/invoices`, () =>
        HttpResponse.json({ success: false, error: 'down' }, { status: 500 }),
      ),
      http.get(`${API}/supplier-invoices`, () =>
        HttpResponse.json({ success: false, error: 'down' }, { status: 500 }),
      ),
      http.get(`${API}/stock-items/report`, () =>
        HttpResponse.json({ success: false, error: 'down' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useDashboardKpis(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.openOrdersCount).toBe(0);
    expect(result.current.data!.stockValue).toBe(0);
    expect(result.current.data!.unpaidInvoicesTotal).toBe(0);
    expect(result.current.data!.unpaidBillsTotal).toBe(0);
  });
});
