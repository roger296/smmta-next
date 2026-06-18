import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface DemandSuggestion {
  productId: string;
  siteId: string;
  windowDays: number;
  leadTimeDays: number;
  minDaysCover: number;
  dailyUsage: number;
  suggestedReorderPoint: number;
  suggestedReorderUpTo: number;
}

/** Demand-based reorder-level suggestions for a site (advisory). */
export function useDemandSuggestions(siteId: string | undefined) {
  return useQuery<DemandSuggestion[]>({
    queryKey: ['reorder', 'demand', siteId],
    queryFn: () => apiFetch<DemandSuggestion[]>('/reorder/suggestions/demand', { searchParams: { siteId } }),
    enabled: !!siteId,
  });
}

/** Accept a suggestion → set the reorder levels via the normal path. */
export function useAcceptDemandSuggestion() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean },
    Error,
    { productId: string; siteId: string; reorderPoint: number; reorderUpTo: number }
  >({
    mutationFn: (body) => apiFetch<{ ok: boolean }>('/reorder/suggestions/accept', { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reorder', 'demand'] });
      qc.invalidateQueries({ queryKey: ['stock-levels'] });
    },
  });
}
