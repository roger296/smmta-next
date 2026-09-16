import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * The venues the signed-in PIN may work at (Sept-2026 user testing, item 1).
 *
 * "some head bakers work at two locations … I would like to add this as a
 *  feature that the user (head baker) can add him or herself - a button on the
 *  ipad app marked 'add location' when they press it they see a list of
 *  locations that can be added, they choose one and confirm."
 *
 * `available` is computed SERVER-SIDE — the screen must not be able to offer a
 * venue the add endpoint would refuse, and the server is the only thing that
 * knows which venues are closed.
 */
export interface MyVenue {
  id: string;
  name: string;
  isHome: boolean;
}

export interface MyVenues {
  label: string;
  sites: MyVenue[];
  available: Array<{ id: string; name: string }>;
}

export const myVenuesKey = ['device-pin', 'me'] as const;

export function useMyVenues(enabled = true) {
  return useQuery<MyVenues>({
    queryKey: myVenuesKey,
    queryFn: () => apiFetch<MyVenues>('/device-pins/me'),
    enabled,
    // A full user login is not a PIN and gets a 400 — no point retrying it.
    retry: false,
  });
}

export function useAddVenue() {
  const qc = useQueryClient();
  return useMutation<{ sites: MyVenue[]; tokenRefreshNeeded: boolean }, Error, string>({
    mutationFn: (siteId) =>
      apiFetch<{ sites: MyVenue[]; tokenRefreshNeeded: boolean }>('/device-pins/me/sites', {
        method: 'POST',
        body: { siteId },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: myVenuesKey }),
  });
}

export function useRemoveVenue() {
  const qc = useQueryClient();
  return useMutation<{ sites: MyVenue[] }, Error, string>({
    mutationFn: (siteId) =>
      apiFetch<{ sites: MyVenue[] }>(`/device-pins/me/sites/${siteId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: myVenuesKey }),
  });
}
