import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type ProspectiveStatus = 'considering' | 'group_buy_open' | 'ordered' | 'ranged' | 'abandoned';

export interface Prospective {
  id: string;
  name: string;
  description: string | null;
  status: ProspectiveStatus;
  interestThreshold: number | null;
  interestCount: number;
  creatorPartner: string | null;
  thresholdCrossedAt: string | null;
}

const KEY = ['prospective'];

export function useProspective() {
  return useQuery({ queryKey: KEY, queryFn: () => apiFetch<Prospective[]>('/admin/prospective') });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateProspective() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { name: string; description?: string; interestThreshold?: number; creatorPartner?: string }) =>
      apiFetch<Prospective>('/admin/prospective', { method: 'POST', body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateProspective() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; status?: ProspectiveStatus; interestThreshold?: number }) =>
      apiFetch(`/admin/prospective/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: invalidate,
  });
}
