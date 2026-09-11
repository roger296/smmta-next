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

/** Buys a label for the order (or retries a failed one). Idempotent server-side. */
export function useCreateShippingLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) =>
      apiFetch<ShippingLabel>(`/orders/${orderId}/shipping-label`, { method: 'POST' }),
    onSettled: (_data, _err, orderId) => {
      qc.invalidateQueries({ queryKey: labelKey(orderId) });
      // A created label writes the tracking number onto the order itself.
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
    },
  });
}

/** Opens the stored label PDF in a new tab. */
export function openShippingLabel(orderId: string): Promise<void> {
  return openAuthedPdf(`/orders/${orderId}/shipping-label/pdf`, 'label');
}
