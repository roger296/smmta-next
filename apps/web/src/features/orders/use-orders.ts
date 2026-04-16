import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { createResourceHooks } from '../_shared/create-resource-hooks';
import type { Invoice, Order, OrderStatus, SourceChannel } from '@/lib/api-types';

export interface OrderListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: OrderStatus;
  customerId?: string;
  sourceChannel?: SourceChannel;
  dateFrom?: string;
  dateTo?: string;
}

export interface CreateOrderLineInput {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  taxRate?: number;
}

export interface CreateOrderInput {
  customerId: string;
  orderDate: string;
  deliveryDate?: string;
  deliveryCharge?: number;
  currencyCode?: string;
  warehouseId?: string;
  vatTreatment?: string;
  sourceChannel?: SourceChannel;
  paymentMethod?: string;
  customerOrderNumber?: string;
  taxInclusive?: boolean;
  lines: CreateOrderLineInput[];
}

const base = createResourceHooks<Order, CreateOrderInput, Partial<CreateOrderInput>, OrderListQuery>({
  basePath: '/orders',
  queryKey: 'orders',
});

export const orderKeys = base.keys;
export const useOrdersList = base.useList;
export const useOrder = base.useOne;
export const useCreateOrder = base.useCreate;
export const useUpdateOrder = base.useUpdate;
export const useDeleteOrder = base.useDelete;

// ============================================================
// Status changes + allocation
// ============================================================

export function useChangeOrderStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, status }: { orderId: string; status: OrderStatus }) =>
      apiFetch<Order>(`/orders/${orderId}/status`, { method: 'PUT', body: { status } }),
    onSuccess: (_data, { orderId }) => {
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
      qc.invalidateQueries({ queryKey: ['orders', 'list'] });
    },
  });
}

export function useAllocateStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, warehouseId }: { orderId: string; warehouseId: string }) =>
      apiFetch<Order>(`/orders/${orderId}/allocate`, {
        method: 'POST',
        body: { warehouseId },
      }),
    onSuccess: (_data, { orderId }) => {
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
    },
  });
}

export function useDeallocateStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) =>
      apiFetch<Order>(`/orders/${orderId}/deallocate`, { method: 'POST' }),
    onSuccess: (_data, orderId) => {
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
    },
  });
}

// ============================================================
// Invoice from order
// ============================================================

export function useCreateInvoiceFromOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      input,
    }: {
      orderId: string;
      input: { dateOfInvoice?: string; dueDateOfInvoice?: string };
    }) =>
      apiFetch<Invoice>(`/orders/${orderId}/invoice`, { method: 'POST', body: input }),
    onSuccess: (_data, { orderId }) => {
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

// ============================================================
// Order notes
// ============================================================

export function useAddOrderNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      input,
    }: {
      orderId: string;
      input: { note: string; isMarked?: boolean; isPickingNote?: boolean };
    }) => apiFetch(`/orders/${orderId}/notes`, { method: 'POST', body: input }),
    onSuccess: (_data, { orderId }) => {
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
    },
  });
}

export const ORDER_STATUSES: { value: OrderStatus; label: string; color: string }[] = [
  { value: 'DRAFT', label: 'Draft', color: 'secondary' },
  { value: 'CONFIRMED', label: 'Confirmed', color: 'outline' },
  { value: 'ALLOCATED', label: 'Allocated', color: 'outline' },
  { value: 'PARTIALLY_ALLOCATED', label: 'Partially allocated', color: 'outline' },
  { value: 'BACK_ORDERED', label: 'Back-ordered', color: 'destructive' },
  { value: 'READY_TO_SHIP', label: 'Ready to ship', color: 'default' },
  { value: 'PARTIALLY_SHIPPED', label: 'Partially shipped', color: 'default' },
  { value: 'SHIPPED', label: 'Shipped', color: 'default' },
  { value: 'INVOICED', label: 'Invoiced', color: 'default' },
  { value: 'COMPLETED', label: 'Completed', color: 'default' },
  { value: 'CANCELLED', label: 'Cancelled', color: 'destructive' },
  { value: 'ON_HOLD', label: 'On hold', color: 'secondary' },
];
