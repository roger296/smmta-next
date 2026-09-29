import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { createResourceHooks } from '../_shared/create-resource-hooks';
import type {
  GRN,
  PODeliveryStatus,
  POInvoicedStatus,
  POLine,
  Product,
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
  /** The venue the order is for — what it will be booked into. */
  siteId?: string;
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

type Raw = Record<string, unknown> & { id: string };
const str = (v: unknown): string => (v == null ? '0' : String(v));

/**
 * The order as the screens use it, from the order as the API sends it.
 *
 * The inherited screens were written against field names the API never sent
 * (`subtotal`, `total`, `supplierName`, a line's `productName` and
 * `quantityReceived`), so totals, names and received quantities all came out
 * blank — and the book-in dialog, reading "received" as nothing, treated
 * every line as complete. The API's own names win here; the old ones are read
 * as a fallback only.
 */
export function normalisePurchaseOrder(raw: Raw): PurchaseOrder {
  const supplier = raw.supplier as { name?: string } | null | undefined;
  const site = raw.site as { name?: string } | null | undefined;
  const lines = (raw.lines as Raw[] | undefined)?.map((l): POLine => {
    const product = l.product as Partial<Product> | null | undefined;
    return {
      ...(l as unknown as POLine),
      productName: product?.name ?? (l.productName as string | undefined),
      purchaseUom: product?.purchaseUom ?? null,
      quantity: str(l.quantity),
      quantityReceived: str(l.qtyBookedIn ?? l.quantityReceived),
      quantityInvoiced: str(l.qtyInvoiced ?? l.quantityInvoiced),
      taxRate: str(l.taxRate),
    };
  });
  return {
    ...(raw as unknown as PurchaseOrder),
    supplierName: supplier?.name ?? (raw.supplierName as string | undefined),
    siteId: (raw.siteId as string | null | undefined) ?? null,
    siteName: site?.name ?? null,
    subtotal: str(raw.lineTotal ?? raw.subtotal),
    taxAmount: str(raw.taxTotal ?? raw.taxAmount),
    total: str(raw.grandTotal ?? raw.total),
    lines,
  };
}

export function usePurchaseOrdersList(params: POListQuery = {}) {
  return useQuery<PaginatedResult<PurchaseOrder>>({
    queryKey: base.keys.list(params),
    queryFn: async () => {
      const res = await apiFetch<PaginatedResult<Raw>>('/purchase-orders', {
        searchParams: params as Record<string, string | number | boolean | undefined>,
      });
      return { ...res, data: res.data.map(normalisePurchaseOrder) };
    },
  });
}

export function usePurchaseOrder(id: string | undefined) {
  return useQuery<PurchaseOrder>({
    queryKey: base.keys.detail(id ?? ''),
    queryFn: async () => normalisePurchaseOrder(await apiFetch<Raw>(`/purchase-orders/${id}`)),
    enabled: !!id,
  });
}

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

// ============================================================
// Booking in against an order (goods-in; DECISIONS.md F24)
// ============================================================

export interface ReceivingLine {
  id: string;
  product: Product;
  ordered: number;
  received: number;
  outstanding: number;
  pricePerUnit: string;
  deliveryStatus: PODeliveryStatus;
}

export interface ReceivingView {
  id: string;
  poNumber: string;
  supplier: { id: string; name: string };
  site: { id: string; name: string } | null;
  deliveryStatus: PODeliveryStatus;
  expectedDeliveryDate: string | null;
  currencyCode: string;
  lines: ReceivingLine[];
  receipts: Array<{
    id: string;
    receivedAt: string;
    deliveryNoteNumber: string | null;
    reference: string | null;
    totalStockValue: string;
    variance: 'NONE' | 'UNDER' | 'OVER';
    lines: number;
    reversalOfReceiptId: string | null;
    reversedAt: string | null;
  }>;
}

/** One order laid out for booking: ordered / received / outstanding per line. */
export function useReceivingView(purchaseOrderId: string | undefined) {
  return useQuery<ReceivingView>({
    queryKey: ['purchase-orders', 'receiving', purchaseOrderId],
    queryFn: () => apiFetch<ReceivingView>(`/purchase-orders/${purchaseOrderId}/receiving`),
    enabled: !!purchaseOrderId,
  });
}

export interface BookAgainstOrderInput {
  purchaseOrderId: string;
  siteId: string;
  deliveryNoteNumber?: string;
  /** Required when anything is more than outstanding — the screen asks first. */
  acceptOverDelivery?: boolean;
  lines: Array<{
    purchaseOrderLineId: string;
    productId: string;
    qtyPurchase: number;
    unitCost?: number;
    batchCode?: string;
    useBy?: string | null;
  }>;
}

/** Book a delivery in against an order, through goods-in (the venue's ledger). */
export function useBookAgainstOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BookAgainstOrderInput) =>
      apiFetch<{ receipt: { id: string } }>('/goods-in', {
        method: 'POST',
        body: { ...input, idempotencyKey: `po-book-in:${crypto.randomUUID()}` },
      }),
    onSuccess: (_d, { purchaseOrderId }) => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['purchase-orders', 'receiving', purchaseOrderId] });
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
