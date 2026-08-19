/**
 * The "needs setup" report (Aug-2026 feedback set, C-1/C-2/C-4).
 *
 * The list to work to zero before the next venue test. See
 * `apps/api/src/modules/products/needs-setup.service.ts` for the rules.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type SetupIssueKind =
  | 'NO_PURCHASE_UOM'
  | 'FACTOR_IS_ONE'
  | 'NO_COST'
  | 'NO_PACK_DESCRIPTION';

export interface SetupIssue {
  kind: SetupIssueKind;
  message: string;
}

export interface NeedsSetupRow {
  id: string;
  name: string;
  stockCode: string | null;
  itemKind: string;
  stockUom: string;
  purchaseUom: string | null;
  purchaseToStockFactor: string;
  packDescription: string | null;
  expectedNextCost: string | null;
  issues: SetupIssue[];
}

export interface NeedsSetupResult {
  rows: NeedsSetupRow[];
  summary: { total: number; byIssue: Record<SetupIssueKind, number> };
}

export const ISSUE_LABELS: Record<SetupIssueKind, string> = {
  NO_PURCHASE_UOM: 'No purchase unit',
  FACTOR_IS_ONE: 'Conversion is 1:1',
  NO_COST: 'No cost',
  NO_PACK_DESCRIPTION: 'No pack description',
};

export function useNeedsSetup() {
  return useQuery<NeedsSetupResult>({
    queryKey: ['products', 'needs-setup'],
    queryFn: () => apiFetch<NeedsSetupResult>('/products/needs-setup'),
  });
}
