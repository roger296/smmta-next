import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface Site {
  id: string;
  slug: string;
  name: string;
  canonicalName: string;
  currencyCode: string;
  uomSystem: 'METRIC' | 'IMPERIAL';
  timezone: string;
  isActive: boolean;
  /** Benches per table at this site (Aug-2026, F-7). null = not set. */
  benchesPerTable: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SiteInput {
  slug: string;
  name: string;
  canonicalName?: string;
  currencyCode?: string;
  uomSystem?: 'METRIC' | 'IMPERIAL';
  timezone?: string;
  isActive?: boolean;
  /** Benches per table (F-7). null clears it back to "not set". */
  benchesPerTable?: number | null;
}

export const siteKeys = {
  all: ['sites'] as const,
};

/** All sites (small list — not paginated). */
export function useSites() {
  return useQuery<Site[]>({
    queryKey: siteKeys.all,
    queryFn: () => apiFetch<Site[]>('/sites'),
  });
}

export function useCreateSite() {
  const qc = useQueryClient();
  return useMutation<Site, Error, SiteInput>({
    mutationFn: (input) => apiFetch<Site>('/sites', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: siteKeys.all }),
  });
}

export function useUpdateSite() {
  const qc = useQueryClient();
  return useMutation<Site, Error, { id: string; input: Partial<SiteInput> }>({
    mutationFn: ({ id, input }) => apiFetch<Site>(`/sites/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: siteKeys.all }),
  });
}
