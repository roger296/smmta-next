import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type PaginatedResult } from '@/lib/api-client';
import type { StockItem, StockItemStatus, StockReportRow } from '@/lib/api-types';

export interface StockItemListQuery {
  page?: number;
  pageSize?: number;
  productId?: string;
  warehouseId?: string;
  status?: StockItemStatus;
  serialNumber?: string;
}

export function useStockItemsList(params: StockItemListQuery = {}) {
  return useQuery<PaginatedResult<StockItem>>({
    queryKey: ['stock-items', 'list', params],
    queryFn: () =>
      apiFetch<PaginatedResult<StockItem>>('/stock-items', {
        searchParams: params as Record<string, string | number | undefined>,
      }),
  });
}

export function useStockItem(id: string | undefined) {
  return useQuery<StockItem>({
    queryKey: ['stock-items', 'detail', id],
    queryFn: () => apiFetch<StockItem>(`/stock-items/${id}`),
    enabled: !!id,
  });
}

export interface StockAdjustmentInput {
  productId: string;
  warehouseId: string;
  type: 'ADD' | 'REMOVE';
  quantity: number;
  valuePerUnit: number;
  currencyCode?: string;
  serialNumbers?: string[];
  reason: string;
}

export function useAdjustStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StockAdjustmentInput) =>
      apiFetch('/stock-items/adjust', { method: 'POST', body: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-items'] });
      qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

export interface StockTransferInput {
  stockItemIds: string[];
  fromWarehouseId: string;
  toWarehouseId: string;
}

export function useTransferStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StockTransferInput) =>
      apiFetch('/stock-items/transfer', { method: 'POST', body: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-items'] });
    },
  });
}

export function useStockReport(params: {
  warehouseId?: string;
  productId?: string;
  asAtDate?: string;
} = {}) {
  return useQuery<StockReportRow[]>({
    queryKey: ['stock-items', 'report', params],
    queryFn: () =>
      apiFetch<StockReportRow[]>('/stock-items/report', {
        searchParams: params as Record<string, string | undefined>,
      }),
  });
}

export function useSerialLookup(serialNumber: string | undefined) {
  return useQuery<StockItem | null>({
    queryKey: ['stock-items', 'serial', serialNumber],
    queryFn: async () => {
      try {
        return await apiFetch<StockItem>(
          `/stock-items/check-serial/${encodeURIComponent(serialNumber!)}`,
        );
      } catch {
        return null;
      }
    },
    enabled: !!serialNumber,
    retry: false,
  });
}

export const STOCK_STATUSES: { value: StockItemStatus; label: string; color: string }[] = [
  { value: 'IN_STOCK', label: 'In stock', color: 'default' },
  { value: 'ALLOCATED', label: 'Allocated', color: 'outline' },
  { value: 'SOLD', label: 'Sold', color: 'secondary' },
  { value: 'RETURNED', label: 'Returned', color: 'outline' },
  { value: 'WRITTEN_OFF', label: 'Written off', color: 'destructive' },
  { value: 'IN_TRANSIT', label: 'In transit', color: 'outline' },
];

/** Build CSV text from stock report rows. Exported for unit testing. */
export function buildStockReportCsv(rows: StockReportRow[]): string {
  const header = ['Warehouse', 'Product', 'Stock code', 'Quantity', 'Total value'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const fields = [
      escapeCsv(r.warehouseName),
      escapeCsv(r.productName),
      escapeCsv(r.stockCode ?? ''),
      String(r.quantity),
      String(r.totalValue),
    ];
    lines.push(fields.join(','));
  }
  return lines.join('\n');
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
