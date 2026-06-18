import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface StockLevelRow {
  productId: string;
  productName: string;
  itemKind: 'MERCH' | 'RETAIL' | 'INGREDIENT' | 'PACKAGING';
  stockUom: string;
  siteId: string;
  siteName: string;
  onHand: string;
  allocated: string;
  reorderPoint: string | null;
  reorderUpTo: string | null;
}

export interface Valuation {
  bySite: Array<{ siteId: string; value: number }>;
  byItemKind: Array<{ siteId: string; itemKind: string; value: number }>;
  total: number;
}

/** On-hand levels for a site (undefined siteId ⇒ query disabled). */
export function useStockLevels(siteId: string | null | undefined) {
  return useQuery<StockLevelRow[]>({
    queryKey: ['stock-levels', siteId],
    queryFn: () => apiFetch<StockLevelRow[]>('/stock-levels', { searchParams: { siteId } }),
    enabled: !!siteId,
  });
}

/** WAC valuation for a site. */
export function useStockValuation(siteId: string | null | undefined) {
  return useQuery<Valuation>({
    queryKey: ['stock-valuation', siteId],
    queryFn: () => apiFetch<Valuation>('/stock-levels/valuation', { searchParams: { siteId } }),
    enabled: !!siteId,
  });
}
