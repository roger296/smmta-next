import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { createResourceHooks } from '../_shared/create-resource-hooks';
import type {
  GRN,
  PODeliveryStatus,
  POInvoicedStatus,
  PurchaseOrder,
  SupplierInvoice,
} from '@/lib/api-types';
import type { PaginatedResult } from '@/lib/api-client';

export interface POListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  supplierId?: string;
  deliveryStatus?: PODeliveryStatus;
  invoicedStatus?: POInvoicedStatus;
}

export interface CreatePOLineInput {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  taxRate?: number;
  expectedDeliveryDate?: string;
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  deliveryWarehouseId?: string;
  currencyCode?: string;
  deliveryCharge?: number;
  vatTreatment?: string;
  exchangeRate?: number;
  expectedDeliveryDate?: string;
  lines: CreatePOLineInput[];
}

const base = createResourceHooks<
  PurchaseOrder,
  CreatePurchaseOrderInput,
  Partial<CreatePurchaseOrderInput>,
  POListQuery
>({
  basePath: '/purchase-orders',
  queryKey: 'purchase-orders',
});

export const poKeys = base.keys;
export const usePurchaseOrdersList = base.useList;
export const usePurchaseOrder = base.useOne;
export const useCreatePurchaseOrder = base.useCreate;
export const useUpdatePurchaseOrder = base.useUpdate;
export const useDeletePurchaseOrder = base.useDelete;

// ============================================================
// PO close + book-in (GRN)
// ============================================================

export function useClosePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PurchaseOrder>(`/purchase-orders/${id}/close`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-orders', 'detail', id] });
      qc.invalidateQueries({ queryKey: ['purchase-orders', 'list'] });
    },
  });
}

export interface BookInLineInput {
  productId: string;
  quantityBookedIn: number;
  valuePerUnit?: number;
  serialNumbers?: string[];
}

export function useBookInPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      purchaseOrderId,
      input,
    }: {
      purchaseOrderId: string;
      input: {
        supplierDeliveryNoteNo?: string;
        dateBookedIn?: string;
        lines: BookInLineInput[];
      };
    }) =>
      apiFetch<GRN>(`/purchase-orders/${purchaseOrderId}/book-in`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (_data, { purchaseOrderId }) => {
      qc.invalidateQueries({ queryKey: ['purchase-orders', 'detail', purchaseOrderId] });
      qc.invalidateQueries({ queryKey: ['grns', 'po', purchaseOrderId] });
      qc.invalidateQueries({ queryKey: ['purchase-orders', 'list'] });
    },
  });
}

export function usePOGRNs(purchaseOrderId: string | undefined) {
  return useQuery<GRN[]>({
    queryKey: ['grns', 'po', purchaseOrderId],
    queryFn: () => apiFetch<GRN[]>(`/purchase-orders/${purchaseOrderId}/grns`),
    enabled: !!purchaseOrderId,
  });
}

// ============================================================
// Supplier invoices
// ============================================================

export interface SupplierInvoiceListQuery {
  page?: number;
  pageSize?: number;
  supplierId?: string;
  status?: string;
}

export function useSupplierInvoicesList(params: SupplierInvoiceListQuery = {}) {
  return useQuery<PaginatedResult<SupplierInvoice>>({
    queryKey: ['supplier-invoices', 'list', params],
    queryFn: () =>
      apiFetch<PaginatedResult<SupplierInvoice>>('/supplier-invoices', {
        searchParams: params as Record<string, string | number | undefined>,
      }),
  });
}

export function useSupplierInvoice(id: string | undefined) {
  return useQuery<SupplierInvoice>({
    queryKey: ['supplier-invoices', 'detail', id],
    queryFn: () => apiFetch<SupplierInvoice>(`/supplier-invoices/${id}`),
    enabled: !!id,
  });
}

export function useCreateSupplierInvoiceFromPO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      purchaseOrderId,
      input,
    }: {
      purchaseOrderId: string;
      input: {
        invoiceNumber: string;
        dateOfInvoice: string;
        dueDateOfInvoice?: string;
        deliveryCharge?: number;
        isStockPurchase?: boolean;
      };
    }) =>
      apiFetch<SupplierInvoice>(`/purchase-orders/${purchaseOrderId}/invoice`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (_data, { purchaseOrderId }) => {
      qc.invalidateQueries({ queryKey: ['purchase-orders', 'detail', purchaseOrderId] });
      qc.invalidateQueries({ queryKey: ['supplier-invoices'] });
    },
  });
}

export function useCreateSupplierCreditNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      invoiceId,
      input,
    }: {
      invoiceId: string;
      input: {
        creditNoteNumber: string;
        dateOfCreditNote: string;
        creditNoteTotal: number;
      };
    }) =>
      apiFetch(`/supplier-invoices/${invoiceId}/credit-note`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (_data, { invoiceId }) => {
      qc.invalidateQueries({ queryKey: ['supplier-invoices', 'detail', invoiceId] });
    },
  });
}

export function useAllocateSupplierPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      invoiceId,
      input,
    }: {
      invoiceId: string;
      input: { amount: number; paymentDate: string; reference?: string };
    }) =>
      apiFetch(`/supplier-invoices/${invoiceId}/payment`, { method: 'POST', body: input }),
    onSuccess: (_data, { invoiceId }) => {
      qc.invalidateQueries({ queryKey: ['supplier-invoices', 'detail', invoiceId] });
    },
  });
}

export const DELIVERY_STATUSES: { value: PODeliveryStatus; label: string; color: string }[] = [
  { value: 'PENDING', label: 'Pending', color: 'secondary' },
  { value: 'PARTIALLY_RECEIVED', label: 'Partially received', color: 'outline' },
  { value: 'FULLY_RECEIVED', label: 'Fully received', color: 'default' },
  { value: 'CANCELLED', label: 'Cancelled', color: 'destructive' },
];
