import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ReorderProposal {
  id: string;
  productId: string;
  siteId: string;
  supplierId: string | null;
  suggestedQtyStock: string;
  suggestedQtyPurchase: string | null;
  purchaseUom: string | null;
  unitCost: string | null;
  currencyCode: string;
  status: 'PROPOSED' | 'APPROVED' | 'PLACED' | 'EMAILED' | 'REJECTED' | 'CANCELLED';
  channel: 'EMAIL_PO' | 'API_CONNECTOR' | null;
  triggeredBy: string;
  supplierOrderRef: string | null;
  createdAt: string;
}

const KEY = ['reorder-proposals'] as const;

export function useReorderProposals(status?: string) {
  return useQuery<ReorderProposal[]>({
    queryKey: [...KEY, status ?? 'all'],
    queryFn: () => apiFetch<ReorderProposal[]>('/reorder/proposals', { searchParams: { status } }),
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: KEY });
}

export function useApproveProposal() {
  const qc = useQueryClient();
  return useMutation<ReorderProposal, Error, string>({
    mutationFn: (id) => apiFetch<ReorderProposal>(`/reorder/proposals/${id}/approve`, { method: 'POST' }),
    onSuccess: () => invalidate(qc),
  });
}

export function usePlaceProposal() {
  const qc = useQueryClient();
  return useMutation<ReorderProposal, Error, string>({
    mutationFn: (id) => apiFetch<ReorderProposal>(`/reorder/proposals/${id}/place`, { method: 'POST' }),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateProposalQty() {
  const qc = useQueryClient();
  return useMutation<ReorderProposal, Error, { id: string; qtyPurchase: number }>({
    mutationFn: ({ id, qtyPurchase }) =>
      apiFetch<ReorderProposal>(`/reorder/proposals/${id}`, {
        method: 'PATCH',
        body: { qtyPurchase },
      }),
    onSuccess: () => invalidate(qc),
  });
}

export function useRunReorderSweep() {
  const qc = useQueryClient();
  return useMutation<{ evaluated: number; created: number }, Error, void>({
    mutationFn: () => apiFetch<{ evaluated: number; created: number }>('/reorder/sweep', { method: 'POST' }),
    onSuccess: () => invalidate(qc),
  });
}
