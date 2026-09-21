import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ShippingLabel } from '@/lib/api-types';
import { openAuthedPdf } from './open-authed-pdf';

const labelKey = (orderId: string | undefined) => ['orders', 'detail', orderId, 'shipping-label'];

/** The order's current label record, or null if none has been requested. */
export function useShippingLabel(orderId: string | undefined) {
  return useQuery<ShippingLabel | null>({
    queryKey: labelKey(orderId),
    queryFn: () => apiFetch<ShippingLabel | null>(`/orders/${orderId}/shipping-label`),
    enabled: !!orderId,
  });
}

/**
 * Creates the order's label, or asks for an existing shipment's label again.
 * With newShipment, replaces a shipment whose label cannot be produced.
 */
export function useCreateShippingLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, newShipment }: { orderId: string; newShipment?: boolean }) =>
      apiFetch<ShippingLabel>(`/orders/${orderId}/shipping-label`, {
        method: 'POST',
        body: newShipment ? { newShipment: true } : undefined,
      }),
    onSettled: (_data, _err, { orderId }) => {
      qc.invalidateQueries({ queryKey: labelKey(orderId) });
      // A created label writes the tracking number onto the order itself.
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
    },
  });
}

export interface OwnLabelInput {
  courierName: string;
  trackingNumber: string;
  trackingLink?: string;
}

/** Records the courier and tracking number of a label made outside this system. */
export function useSetOwnLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...body }: OwnLabelInput & { orderId: string }) =>
      apiFetch(`/orders/${orderId}/own-label`, { method: 'PUT', body }),
    // The order, its readiness and its label all live under this key.
    onSettled: (_data, _err, { orderId }) => qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] }),
  });
}

/** Back to needing a bought label. */
export function useClearOwnLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => apiFetch(`/orders/${orderId}/own-label`, { method: 'DELETE' }),
    onSettled: (_data, _err, orderId) => qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] }),
  });
}

/** Opens the stored label PDF in a new tab. */
export function openShippingLabel(orderId: string): Promise<void> {
  return openAuthedPdf(`/orders/${orderId}/shipping-label/pdf`, 'label');
}
