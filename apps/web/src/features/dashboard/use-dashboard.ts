import { useQuery } from '@tanstack/react-query';
import { apiFetch, type PaginatedResult } from '@/lib/api-client';
import type { Invoice, Order, SupplierInvoice, StockReportRow } from '@/lib/api-types';

export interface DashboardKpis {
  openOrdersCount: number;
  openOrdersValue: number;
  stockValue: number;
  unpaidInvoicesTotal: number;
  unpaidBillsTotal: number;
  recentOrders: Order[];
}

/** Aggregates several endpoints into a single dashboard summary. */
export function useDashboardKpis() {
  return useQuery<DashboardKpis>({
    queryKey: ['dashboard'],
    queryFn: async () => {
      // Run in parallel
      const [openOrders, invoices, bills, stock] = await Promise.all([
        apiFetch<PaginatedResult<Order>>('/orders', {
          searchParams: { pageSize: 20 },
        }),
        apiFetch<PaginatedResult<Invoice>>('/invoices', {
          searchParams: { pageSize: 100, status: 'ISSUED' },
        }).catch(() => ({ data: [], total: 0, page: 1, pageSize: 100, totalPages: 0 })),
        apiFetch<PaginatedResult<SupplierInvoice>>('/supplier-invoices', {
          searchParams: { pageSize: 100 },
        }).catch(() => ({ data: [], total: 0, page: 1, pageSize: 100, totalPages: 0 })),
        apiFetch<StockReportRow[]>('/stock-items/report').catch(() => []),
      ]);

      const openStatuses = new Set([
        'DRAFT',
        'CONFIRMED',
        'ALLOCATED',
        'PARTIALLY_ALLOCATED',
        'BACK_ORDERED',
        'READY_TO_SHIP',
        'PARTIALLY_SHIPPED',
      ]);
      const open = openOrders.data.filter((o) => openStatuses.has(o.status));
      const openOrdersValue = open.reduce((s, o) => s + Number(o.total), 0);

      const stockValue = stock.reduce((s, r) => s + Number(r.totalValue), 0);
      const unpaidInvoicesTotal = invoices.data.reduce(
        (s, i) => s + Number(i.outstandingAmount),
        0,
      );
      const unpaidBillsTotal = bills.data
        .filter((b) => b.status !== 'PAID' && b.status !== 'VOIDED')
        .reduce((s, b) => s + Number(b.outstandingAmount), 0);

      return {
        openOrdersCount: open.length,
        openOrdersValue,
        stockValue,
        unpaidInvoicesTotal,
        unpaidBillsTotal,
        recentOrders: openOrders.data.slice(0, 10),
      };
    },
  });
}
