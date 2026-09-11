import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PickNote } from '@/lib/api-types';
import { openAuthedPdf } from './open-authed-pdf';

export const pickNoteKey = (orderId: string | undefined) => ['orders', 'detail', orderId, 'pick-note'];

/** The order's pick note record, or null if none has been made yet. */
export function usePickNote(orderId: string | undefined) {
  return useQuery<PickNote | null>({
    queryKey: pickNoteKey(orderId),
    queryFn: () => apiFetch<PickNote | null>(`/orders/${orderId}/pick-note`),
    enabled: !!orderId,
  });
}

/** Creates the pick note, or re-creates it even if the order has not changed. */
export function useRecreatePickNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => apiFetch<PickNote>(`/orders/${orderId}/pick-note`, { method: 'POST' }),
    onSettled: (_data, _err, orderId) => {
      qc.invalidateQueries({ queryKey: pickNoteKey(orderId) });
    },
  });
}

/**
 * Opens the pick note PDF in a new tab. The server re-creates the note first if
 * the order has changed, so what opens is always current.
 */
export function openPickNote(orderId: string): Promise<void> {
  return openAuthedPdf(`/orders/${orderId}/pick-note/pdf`, 'pick note');
}
