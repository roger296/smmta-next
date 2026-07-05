/**
 * Approval-queue data hooks (SPEC §17). Wraps the admin queue endpoints with
 * TanStack Query, matching the repo's per-feature hook convention.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface QueueItem {
  type: 'draft' | 'escalation';
  id: string;
  rank: number;
  subject: string;
  groupKey: string | null;
  category: string;
  expiresInMs: number | null;
  createdAt: string;
}

export interface DraftDetail {
  draft: { id: string; subject: string; body: string; category: string; status: string };
  facts: { eventType: string; payload: unknown } | null;
}

export type RejectReason = 'wrong_facts' | 'wrong_tone' | 'should_not_send' | 'other';

export function useQueue() {
  return useQuery({
    queryKey: ['approval-queue'],
    queryFn: () => apiFetch<QueueItem[]>('/admin/queue'),
    refetchInterval: 30_000,
  });
}

export function useDraftDetail(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['approval-draft', id],
    queryFn: () => apiFetch<DraftDetail>(`/admin/queue/drafts/${id}`),
    enabled,
  });
}

function useQueueInvalidation() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['approval-queue'] });
}

export function useApproveDraft() {
  const invalidate = useQueueInvalidation();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/queue/drafts/${id}/approve`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useRejectDraft() {
  const invalidate = useQueueInvalidation();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: RejectReason }) =>
      apiFetch(`/admin/queue/drafts/${id}/reject`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}

export function useResolveEscalation() {
  const invalidate = useQueueInvalidation();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/escalations/${id}/resolve`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}
