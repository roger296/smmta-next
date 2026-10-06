import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiFetchBlob, triggerBlobDownload } from '@/lib/api-client';

/**
 * Stock-take results on the admin website (Oct 2026).
 *
 * "make it possible to see and download the stock count results from the app
 * UI in a web browser" — the count screen is an iPad page that shows one
 * venue's counts one at a time. This is the head-office view: every venue,
 * any status, any date range, with downloads.
 */

export interface StockTakeRow {
  id: string;
  siteId: string;
  scope: string;
  status: 'OPEN' | 'APPROVED' | 'CANCELLED';
  createdAt: string;
  approvedAt: string | null;
  openedByName: string | null;
  lineCount: number;
  countedCount: number;
  counters: string[];
  lastCountedAt: string | null;
}

export interface StockTakeLine {
  productId: string;
  productName: string | null;
  stockCode: string | null;
  stockUom: string | null;
  itemCategoryName: string | null;
  bookQty: string;
  countedQty: string | null;
  variance: string | null;
  countedByName: string | null;
  countedAt: string | null;
}

export interface StockTakeFilters {
  siteId?: string;
  status?: string;
  /** YYYY-MM-DD, London days, inclusive. */
  from?: string;
  to?: string;
}

const params = (f: StockTakeFilters) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>;

export function useStockTakeList(filters: StockTakeFilters) {
  return useQuery<StockTakeRow[]>({
    queryKey: ['stock-takes', 'admin', filters],
    queryFn: () => apiFetch<StockTakeRow[]>('/stock-takes', { searchParams: params(filters) }),
  });
}

export function useStockTakeDetail(id: string) {
  return useQuery<{ take: StockTakeRow; lines: StockTakeLine[] }>({
    queryKey: ['stock-take', 'admin', id],
    queryFn: () => apiFetch(`/stock-takes/${id}`),
  });
}

/** Set an open count aside (managers). Refreshes every list it appears in. */
export function useCancelStockTake() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/stock-takes/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock-takes'] });
      void qc.invalidateQueries({ queryKey: ['stock-take'] });
    },
  });
}

/** One count as a spreadsheet, or every counted line of the filtered counts. */
export function useStockTakeDownloads() {
  return useMutation<void, Error, { id: string } | { filters: StockTakeFilters }>({
    mutationFn: async (what) => {
      const { blob, filename } =
        'id' in what
          ? await apiFetchBlob(`/stock-takes/${what.id}/export.csv`)
          : await apiFetchBlob('/stock-takes/export.csv', { searchParams: params(what.filters) });
      triggerBlobDownload(blob, filename ?? `stock-takes-${new Date().toISOString().slice(0, 10)}.csv`);
    },
  });
}

/** YYYY-MM-DD for a date `daysAgo` before today, on the London calendar. */
export function londonDaysAgo(daysAgo: number, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(
    new Date(now.getTime() - daysAgo * 86_400_000),
  );
}

/** "Wed 30 Sep 2026, 15:47" — a list of counts spans more than one day. */
export function whenLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export const SCOPE_LABEL: Record<string, string> = {
  FULL: 'Full count',
  CYCLE: 'Cycle count',
  CATEGORY: 'Category count',
  ITEM: 'Single item',
  ZONE: 'Zone count',
};
export const STATUS_LABEL: Record<string, string> = { OPEN: 'Open', APPROVED: 'Approved', CANCELLED: 'Cancelled' };
