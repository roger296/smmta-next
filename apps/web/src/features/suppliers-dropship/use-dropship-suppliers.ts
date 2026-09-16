import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface DropshipSupplierRow {
  id: string;
  name: string;
  slug: string | null;
  connectorKind: 'NONE' | 'UNEEK' | 'RALAWISE' | 'STUB';
  apiBaseUrl: string | null;
  apiAuthScheme: string;
  isDropshipActive: boolean;
  pollIntervalMinutes: number;
  dispatchSlaMinDays: number;
  dispatchSlaMaxDays: number;
  rateLimitRequests: number | null;
  rateLimitWindowSeconds: number | null;
  minRequestIntervalMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  showSupplierNameToCustomers: boolean;
  /** Customer delivery charge for this supplier's parcel, inc VAT; null = standard rate. */
  deliveryChargeGbp: string | null;
  /** Our account (customer) number with the supplier, e.g. Uneek's TBV02. */
  accountNumber: string | null;
  /** The email address on our account with the supplier. */
  customerAccountEmail: string | null;
  /** The supplier's code for how an order should be sent, e.g. "DPD". */
  deliveryMethodCode: string | null;
  hasApiKey: boolean;
}

export interface DropshipSupplierDetail {
  supplier: DropshipSupplierRow;
  recentPollLog: Array<{
    id: string;
    startedAt: string;
    finishedAt: string | null;
    productsChecked: number;
    productsUpdated: number;
    errorMessage: string | null;
  }>;
  mappingCount: number;
}

export interface SupplierMappingRow {
  id: string;
  productId: string;
  supplierId: string;
  supplierSku: string;
  costGbp: string;
  lastKnownStock: number | null;
  lastKnownPrice: string | null;
  lastPolledAt: string | null;
  lastPollError: string | null;
  isActive: boolean;
  priority: number;
}

export function useDropshipSuppliers() {
  return useQuery<DropshipSupplierRow[]>({
    queryKey: ['dropship-suppliers'],
    queryFn: () => apiFetch<DropshipSupplierRow[]>('/suppliers-dropship'),
  });
}

export function useDropshipSupplier(id: string | undefined) {
  return useQuery<DropshipSupplierDetail>({
    queryKey: ['dropship-suppliers', 'detail', id],
    queryFn: () => apiFetch<DropshipSupplierDetail>(`/suppliers-dropship/${id}`),
    enabled: !!id,
  });
}

export interface DropshipUpdateInput {
  slug?: string;
  connectorKind?: 'NONE' | 'UNEEK' | 'RALAWISE' | 'STUB';
  apiBaseUrl?: string | null;
  apiKeyPlaintext?: string;
  apiAuthScheme?: string;
  isDropshipActive?: boolean;
  pollIntervalMinutes?: number;
  dispatchSlaMinDays?: number;
  dispatchSlaMaxDays?: number;
  rateLimitRequests?: number | null;
  rateLimitWindowSeconds?: number | null;
  minRequestIntervalMs?: number | null;
  showSupplierNameToCustomers?: boolean;
  deliveryChargeGbp?: string | null;
  accountNumber?: string | null;
  customerAccountEmail?: string | null;
  deliveryMethodCode?: string | null;
}

export function useUpdateDropshipSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: DropshipUpdateInput }) =>
      apiFetch<DropshipSupplierRow>(`/suppliers-dropship/${id}`, {
        method: 'PUT',
        body: input,
      }),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: ['dropship-suppliers'] });
      qc.invalidateQueries({ queryKey: ['dropship-suppliers', 'detail', id] });
    },
  });
}

export function useTestDropshipConnection() {
  return useMutation({
    mutationFn: ({ id, supplierSku }: { id: string; supplierSku: string }) =>
      apiFetch<{
        ok: boolean;
        error?: string;
        snapshots?: Array<{ supplierSku: string; stockQty: number | null; costGbp: number | null }>;
      }>(`/suppliers-dropship/${id}/test`, {
        method: 'POST',
        body: { supplierSku },
      }),
  });
}

export function usePollNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiFetch<
        Array<{
          supplierId: string;
          supplierSlug: string;
          productsChecked: number;
          productsUpdated: number;
          errorMessage: string | null;
          skippedBecause?: string;
        }>
      >(`/suppliers-dropship/${id}/poll-now`, { method: 'POST' }),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: ['dropship-suppliers', 'detail', id] });
      qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

export function useProductSupplierMappings(productId: string | undefined) {
  return useQuery<SupplierMappingRow[]>({
    queryKey: ['products', 'detail', productId, 'supplier-mappings'],
    queryFn: () =>
      apiFetch<SupplierMappingRow[]>(`/products/${productId}/supplier-mappings`),
    enabled: !!productId,
  });
}

export interface UpsertMappingsInput {
  mappings: Array<{
    supplierId: string;
    supplierSku: string;
    costGbp: string;
    priority: number;
    isActive: boolean;
  }>;
}

export function useUpsertSupplierMappings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, input }: { productId: string; input: UpsertMappingsInput }) =>
      apiFetch<SupplierMappingRow[]>(`/products/${productId}/supplier-mappings`, {
        method: 'PUT',
        body: input,
      }),
    onSuccess: (_d, { productId }) => {
      qc.invalidateQueries({
        queryKey: ['products', 'detail', productId, 'supplier-mappings'],
      });
    },
  });
}
