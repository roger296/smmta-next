import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ExpectedLine {
  productId: string;
  qtyPerCover: number;
  expectedQty: number;
  stockUom: string;
  unitCost: number | null;
  expectedCost: number | null;
}

export interface ConsumptionLine {
  id: string;
  productId: string;
  expectedQty: string;
  actualQty: string;
  wastageQty: string;
  wastageReason: string | null;
  unitCost: string | null;
  variance: string;
  stockUom: string;
}

export interface ConsumptionRecord {
  id: string;
  siteId: string;
  sessionId: string;
  sessionDate: string;
  bakerName: string;
  bake: string | null;
  covers: number;
  version: number;
  materialsCost: string;
  submittedAt: string | null;
}

export interface AwaitingSession {
  sessionId: string;
  sessionDate: string;
  covers: number;
}

/** Compute expected consumption for a session = recipe(cake) × covers. */
export function useExpectedConsumption() {
  return useMutation<
    ExpectedLine[],
    Error,
    { siteId: string; onDate: string; bake: string; covers: number }
  >({
    mutationFn: (input) => apiFetch<ExpectedLine[]>('/recipes/expected', { method: 'POST', body: input }),
  });
}

/** Submitted consumption records (newest first), optionally by site / date. */
export function useConsumptionList(filter?: { siteId?: string; sessionDate?: string }) {
  return useQuery<ConsumptionRecord[]>({
    queryKey: ['consumption', filter ?? {}],
    queryFn: () => apiFetch<ConsumptionRecord[]>('/session-consumption', { searchParams: filter }),
  });
}

/** Sessions at a site (for a date) with no consumption record yet. */
export function useSessionsAwaiting(siteId: string | undefined, date: string | undefined) {
  return useQuery<AwaitingSession[]>({
    queryKey: ['consumption', 'awaiting', siteId, date],
    queryFn: () => apiFetch<AwaitingSession[]>('/session-consumption/awaiting', { searchParams: { siteId, date } }),
    enabled: !!siteId && !!date,
  });
}

export interface SweepResult {
  date: string;
  sites: number;
  cogsPosted: number;
  wastagePosted: number;
  totalCogs: number;
  totalWastage: number;
}

/** Run the daily COGS / wastage Xero sweep for a date (dry-run by default). */
export function useConsumptionSweep() {
  const qc = useQueryClient();
  return useMutation<SweepResult, Error, { date: string }>({
    mutationFn: (input) => apiFetch<SweepResult>('/session-consumption/sweep', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consumption'] }),
  });
}
