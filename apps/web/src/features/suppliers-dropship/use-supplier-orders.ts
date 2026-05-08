import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type SupplierOrderStatus =
  | 'PENDING'
  | 'PLACED'
  | 'ACKNOWLEDGED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'FAILED';

export interface SupplierOrderRow {
  id: string;
  customerOrderId: string;
  supplierId: string;
  idempotencyKey: string;
  supplierOrderRef: string | null;
  status: SupplierOrderStatus;
  errorMessage: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  shippedAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierOrderDetail extends SupplierOrderRow {
  requestPayload: Record<string, unknown> | null;
  responsePayload: Record<string, unknown> | null;
  supplier: { id: string; name: string; slug: string | null } | null;
}

export interface SupplierOrdersQuery {
  status?: SupplierOrderStatus;
  supplierId?: string;
  limit?: number;
}

export function useSupplierOrders(query: SupplierOrdersQuery = {}) {
  const qs = new URLSearchParams();
  if (query.status) qs.set('status', query.status);
  if (query.supplierId) qs.set('supplierId', query.supplierId);
  if (query.limit) qs.set('limit', String(query.limit));
  const search = qs.toString();
  return useQuery<SupplierOrderRow[]>({
    queryKey: ['supplier-orders', query],
    queryFn: () =>
      apiFetch<SupplierOrderRow[]>(`/supplier-orders${search ? `?${search}` : ''}`),
  });
}

export function useSupplierOrder(id: string | undefined) {
  return useQuery<SupplierOrderDetail>({
    queryKey: ['supplier-orders', 'detail', id],
    queryFn: () => apiFetch<SupplierOrderDetail>(`/supplier-orders/${id}`),
    enabled: !!id,
  });
}

export function useRetrySupplierOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiFetch<{ success: boolean }>(`/supplier-orders/${id}/retry`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supplier-orders'] }),
  });
}

export function useCancelSupplierOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiFetch<{ success: boolean }>(`/supplier-orders/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supplier-orders'] }),
  });
}

export function useMarkSupplierOrderShipped() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      trackingCarrier,
      trackingNumber,
    }: { id: string; trackingCarrier?: string; trackingNumber?: string }) =>
      apiFetch<{ success: boolean }>(`/supplier-orders/${id}/mark-shipped`, {
        method: 'POST',
        body: { trackingCarrier, trackingNumber },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supplier-orders'] }),
  });
}
