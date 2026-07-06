/**
 * Auto-send graduation hooks (SPEC §17.6). Per message-type approved-unedited
 * rate + a reversible auto-send toggle.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface AgentConfigRow {
  eventType: string;
  autoSendEnabled: boolean;
  approvedUneditedRateBp: number | null;
}
export interface GraduationStats {
  sampleSize: number;
  approvedUneditedRate: number;
}

/** The message types that can graduate to auto-send (mirror templates.ts). */
export const TEMPLATE_KEYS = [
  'eta_slip',
  'back_in_stock',
  'price_drop_offer',
  'run_out_reminder',
  'preorder_fulfilment',
  'lapsed_winback',
  'subscription_upsell',
] as const;

export function useAgentConfig() {
  return useQuery({ queryKey: ['agent-config'], queryFn: () => apiFetch<AgentConfigRow[]>('/admin/agent-config') });
}

export function useGraduation(key: string) {
  return useQuery({
    queryKey: ['graduation', key],
    queryFn: () => apiFetch<GraduationStats>(`/admin/agent-config/${key}/graduation`),
  });
}

export function useSetAutoSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      apiFetch(`/admin/agent-config/${key}/auto-send`, { method: 'POST', body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-config'] }),
  });
}
