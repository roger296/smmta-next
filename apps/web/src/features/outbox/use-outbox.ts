import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface OutboxFailure {
  id: string;
  toEmail: string;
  template: string;
  error: string | null;
  statusCode: number | null;
  attempts: number;
  nextAttemptAt: string | null;
  updatedAt: string;
}

export interface OutboxStatus {
  counts: { PENDING: number; SENT: number; FAILED: number };
  awaitingRetry: number;
  stuck: number;
  oldestUnsentAgeSeconds: number | null;
  lastSentAt: string | null;
  recentFailures: OutboxFailure[];
}

/** Proxied by the API from the storefront, which owns the outbox table. */
export function useOutbox() {
  return useQuery<OutboxStatus>({
    queryKey: ['outbox'],
    queryFn: () => apiFetch<OutboxStatus>('/admin/outbox'),
    // Operators watch this page while a queue drains, so keep it live.
    refetchInterval: 30_000,
  });
}
