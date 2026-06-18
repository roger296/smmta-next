import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface SquareMapRow {
  id: string;
  squareKey: string;
  productId: string;
  autoMatched: boolean;
}

export interface SquareUnmappedRow {
  id: string;
  channelSlug: string;
  sourcePk: string;
  sourceLineRef: string;
  squareKey: string | null;
  siteRef: string | null;
  qty: string;
  reason: string;
}

export function useSquareMap() {
  return useQuery<SquareMapRow[]>({
    queryKey: ['square-map'],
    queryFn: () => apiFetch<SquareMapRow[]>('/square/item-map'),
  });
}

export function useSquareUnmapped() {
  return useQuery<SquareUnmappedRow[]>({
    queryKey: ['square-unmapped'],
    queryFn: () => apiFetch<SquareUnmappedRow[]>('/square/unmapped'),
  });
}

export function useUpsertSquareMap() {
  const qc = useQueryClient();
  return useMutation<{ updated: number }, Error, Array<{ squareKey: string; productId: string }>>({
    mutationFn: (entries) =>
      apiFetch<{ updated: number }>('/square/item-map', { method: 'PUT', body: { entries } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['square-map'] });
      qc.invalidateQueries({ queryKey: ['square-unmapped'] });
    },
  });
}
