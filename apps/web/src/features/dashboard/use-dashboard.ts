import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface DashboardSite {
  id: string;
  name: string;
  slug: string | null;
  currencyCode: string;
}

export interface SessionRow {
  siteId: string;
  sessions: number;
  filed: number;
  missing: number;
  missingSessionIds: string[];
}

export interface StockRow {
  siteId: string;
  value: number;
  currencyCode: string;
  linesTracked: number;
}

export interface ReorderRow {
  siteId: string;
  belowReorderPoint: number;
  openProposals: number;
  topItems: Array<{ productId: string; name: string; onHand: number; reorderPoint: number | null }>;
}

export interface DashboardOverview {
  date: string;
  sites: DashboardSite[];
  sessions: { available: boolean; reason?: string; rows: SessionRow[] };
  stock: { available: boolean; reason?: string; rows: StockRow[]; total: number };
  reorder: { available: boolean; reason?: string; rows: ReorderRow[] };
}

/**
 * One call for the whole landing page.
 *
 * The previous version fanned out to four endpoints and aggregated in the
 * browser, with a catch on only three of them — so one unconfigured
 * integration produced "Failed to load dashboard data" and nothing else. The
 * API now answers in a single shape where each section reports its own
 * availability, so a section that can't answer degrades on its own.
 */
export function useDashboardOverview() {
  return useQuery<DashboardOverview>({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => apiFetch<DashboardOverview>('/dashboard/overview'),
    staleTime: 60_000,
  });
}
