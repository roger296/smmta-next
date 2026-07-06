import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface DigestPayload {
  date: string;
  queue: { pending: number; byType: Record<string, number> };
  autoSent: number;
  failedDrafts: number;
  expiredDrafts: number;
  openEscalations: number;
  paymentWindow: { awaiting: number; overdue: number };
  llmSpend: { spentMicroUsd: number; capMicroUsd: number; overCap: boolean };
  upcomingRenewals: number;
  marketingSegments: Record<string, number>;
  jobFailures: number;
}

export function useDigest() {
  return useQuery({
    queryKey: ['digest'],
    queryFn: () => apiFetch<DigestPayload>('/admin/digest'),
    refetchInterval: 60_000,
  });
}
