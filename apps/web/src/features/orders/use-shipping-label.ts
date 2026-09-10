import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, apiFetch } from '@/lib/api-client';
import { getToken } from '@/lib/auth';
import type { ShippingLabel } from '@/lib/api-types';

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

/**
 * Opens the stored label PDF in a new tab.
 *
 * The PDF route needs the admin's token, which a plain link cannot send, so
 * the file is fetched and handed to the browser as a blob. The tab is opened
 * BEFORE the fetch, while still inside the click, because browsers block a
 * window.open that happens after an await.
 */
export async function openShippingLabel(orderId: string): Promise<void> {
  const tab = window.open('about:blank', '_blank');
  try {
    const base = API_BASE_URL.startsWith('http') ? API_BASE_URL : `${window.location.origin}${API_BASE_URL}`;
    const token = getToken();
    const res = await fetch(`${base}/orders/${orderId}/shipping-label/pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Could not load the label (status ${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    if (tab) {
      tab.location.href = url;
    } else {
      window.location.assign(url);
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
