import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface MarketplaceImportConfig {
  channel: 'SHOPIFY' | 'EBAY' | 'ETSY';
  shopDomain?: string;
  accessToken: string;
  sellerId?: string;
  sinceId?: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors?: { reference: string; error: string }[];
}

export function useMarketplaceImport() {
  const qc = useQueryClient();
  return useMutation<ImportResult, Error, MarketplaceImportConfig>({
    mutationFn: (config) =>
      apiFetch<ImportResult>('/import/marketplace', { method: 'POST', body: config }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export function useCSVImport() {
  const qc = useQueryClient();
  return useMutation<ImportResult, Error, string>({
    mutationFn: (csvText) =>
      apiFetch<ImportResult>('/import/csv-orders', { method: 'POST', body: { csvText } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

// ============================================================
// Bulk order operations
// ============================================================

export interface BulkResult {
  succeeded: number;
  failed: number;
  errors?: { orderId: string; error: string }[];
}

export function useBulkStatusChange() {
  const qc = useQueryClient();
  return useMutation<BulkResult, Error, { orderIds: string[]; status: string }>({
    mutationFn: (input) =>
      apiFetch<BulkResult>('/orders/bulk/status', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export function useBulkShip() {
  const qc = useQueryClient();
  return useMutation<
    BulkResult,
    Error,
    {
      orders: { orderId: string; trackingNumber?: string; courierName?: string }[];
    }
  >({
    mutationFn: (input) =>
      apiFetch<BulkResult>('/orders/bulk/ship', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export function useBulkInvoice() {
  const qc = useQueryClient();
  return useMutation<BulkResult, Error, { orderIds: string[] }>({
    mutationFn: (input) =>
      apiFetch<BulkResult>('/orders/bulk/invoice', { method: 'POST', body: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

export function useBulkAllocate() {
  const qc = useQueryClient();
  return useMutation<BulkResult, Error, { orderIds: string[]; warehouseId: string }>({
    mutationFn: (input) =>
      apiFetch<BulkResult>('/orders/bulk/allocate', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

// ============================================================
// Year-end close
// ============================================================

export function useYearEndClose() {
  return useMutation<{ fromDate: string; toDate: string }, Error, { fromDate: string; toDate: string }>({
    mutationFn: (input) =>
      apiFetch<{ fromDate: string; toDate: string }>('/year-end-close', {
        method: 'POST',
        body: input,
      }),
  });
}

// ============================================================
// CSV parsing helpers (client-side preview)
// ============================================================

export interface ParsedCSVRow {
  [key: string]: string;
}

/**
 * Minimal CSV parser supporting double-quoted fields with embedded commas
 * and escaped quotes. Used for client-side preview only.
 */
export function parseCSVPreview(csv: string, maxRows = 50): {
  headers: string[];
  rows: ParsedCSVRow[];
  error?: string;
} {
  const lines = csv.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [], error: 'Empty CSV' };
  const headers = parseCSVLine(lines[0]!);
  const rows: ParsedCSVRow[] = [];
  for (let i = 1; i < Math.min(lines.length, maxRows + 1); i++) {
    const fields = parseCSVLine(lines[i]!);
    const row: ParsedCSVRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = fields[j] ?? '';
    }
    rows.push(row);
  }
  return { headers, rows };
}

export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === ',') {
        fields.push(current);
        current = '';
      } else if (ch === '"' && current === '') {
        inQuotes = true;
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}
