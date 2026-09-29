import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface OptionRow {
  supplierProductId: string;
  productId: string;
  productName: string;
  stockCode: string | null;
  supplierId: string;
  supplierName: string;
  supplierSku: string;
  costGbp: string | null;
  spendSeen12m: number;
  lastPrice: string | null;
  lastPriceAt: string | null;
  previousPrice: string | null;
}

export interface Listed<T> {
  total: number;
  rows: T[];
}

export interface BuyingDataHealth {
  generatedAt: string;
  thresholds: { stalePriceDays: number; priceMoveAlert: number };
  noBuyingOption: Listed<{ productId: string; productName: string; stockCode: string | null; hasReorderPoint: boolean }>;
  packSizeMissing: Listed<OptionRow>;
  noPrice: Listed<OptionRow>;
  stalePrice: Listed<OptionRow>;
  priceMoves: Listed<OptionRow & { change: number }>;
  supplierAccounts: Listed<{
    supplierId: string;
    supplierName: string;
    options: number;
    venues: number;
    venuesDatable: number;
    spendSeen12m: number;
  }>;
}

export function useBuyingDataHealth() {
  return useQuery<BuyingDataHealth>({
    queryKey: ['buying-data', 'health'],
    queryFn: () => apiFetch<BuyingDataHealth>('/buying-data/health'),
  });
}
