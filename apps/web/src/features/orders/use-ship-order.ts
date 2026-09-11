import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ShipReadiness, ShipResult } from '@/lib/api-types';
import { openAuthedPdf, printAuthedPdf } from './open-authed-pdf';

export const shipReadinessKey = (orderId: string | undefined) => ['orders', 'detail', orderId, 'ship-readiness'];

/** Whether the order can be shipped now, and if not, why. */
export function useShipReadiness(orderId: string | undefined) {
  return useQuery<ShipReadiness>({
    queryKey: shipReadinessKey(orderId),
    queryFn: () => apiFetch<ShipReadiness>(`/orders/${orderId}/ship-readiness`),
    enabled: !!orderId,
  });
}

/** Ships the order: stock sold, status shipped, invoice made, customer emailed. */
export function useShipOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => apiFetch<ShipResult>(`/orders/${orderId}/ship`, { method: 'POST' }),
    onSettled: (_data, _err, orderId) => {
      // The order, its readiness, label and pick note all live under this key.
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
      qc.invalidateQueries({ queryKey: ['orders', 'list'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

/** Opens the print dialog for the pick note and label as one document. */
export function printDispatchDocuments(orderId: string): Promise<void> {
  return printAuthedPdf(`/orders/${orderId}/dispatch-documents/pdf`, 'dispatch documents');
}

/** Opens the invoice PDF in a new tab. */
export function openInvoicePdf(invoiceId: string): Promise<void> {
  return openAuthedPdf(`/invoices/${invoiceId}/pdf`, 'invoice');
}
