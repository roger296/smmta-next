import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CreditNote, Invoice, InvoiceStatus, Payment } from '@/lib/api-types';
import type { PaginatedResult as PR } from '@/lib/api-client';

export interface InvoiceListQuery {
  page?: number;
  pageSize?: number;
  status?: InvoiceStatus;
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export function useInvoicesList(params: InvoiceListQuery = {}) {
  return useQuery<PR<Invoice>>({
    queryKey: ['invoices', 'list', params],
    queryFn: () =>
      apiFetch<PR<Invoice>>('/invoices', {
        searchParams: params as Record<string, string | number | undefined>,
      }),
  });
}

export function useInvoice(id: string | undefined) {
  return useQuery<Invoice>({
    queryKey: ['invoices', 'detail', id],
    queryFn: () => apiFetch<Invoice>(`/invoices/${id}`),
    enabled: !!id,
  });
}

export function useCreateCreditNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      invoiceId,
      input,
    }: {
      invoiceId: string;
      input: {
        dateOfCreditNote: string;
        lines: {
          productId: string;
          quantity: number;
          pricePerUnit: number;
          taxRate?: number;
          description?: string;
        }[];
      };
    }) =>
      apiFetch<CreditNote>(`/invoices/${invoiceId}/credit-note`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (_data, { invoiceId }) => {
      qc.invalidateQueries({ queryKey: ['invoices', 'detail', invoiceId] });
    },
  });
}

export function useAllocatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      invoiceId,
      input,
    }: {
      invoiceId: string;
      input: { amount: number; paymentDate: string; reference?: string };
    }) =>
      apiFetch<Payment>(`/invoices/${invoiceId}/payment`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (_data, { invoiceId }) => {
      qc.invalidateQueries({ queryKey: ['invoices', 'detail', invoiceId] });
    },
  });
}

export const INVOICE_STATUSES: { value: InvoiceStatus; label: string; color: string }[] = [
  { value: 'DRAFT', label: 'Draft', color: 'secondary' },
  { value: 'ISSUED', label: 'Issued', color: 'outline' },
  { value: 'PARTIALLY_PAID', label: 'Partially paid', color: 'outline' },
  { value: 'PAID', label: 'Paid', color: 'default' },
  { value: 'VOIDED', label: 'Voided', color: 'destructive' },
];
