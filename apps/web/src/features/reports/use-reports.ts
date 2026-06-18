import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface Period {
  from: string;
  to: string;
  siteId?: string;
}

export interface VarianceRow {
  siteId: string;
  siteName: string;
  productId: string;
  productName: string;
  stockUom: string;
  expectedQty: number;
  actualQty: number;
  wastageQty: number;
  varianceQty: number;
  variancePct: number | null;
  expectedCost: number;
  actualCost: number;
  wastageCost: number;
  varianceCost: number;
  shrinkageQty: number;
  shrinkageCost: number;
}

export interface WastageRow {
  siteId: string;
  siteName: string;
  productId: string;
  productName: string;
  stockUom: string;
  wastageQty: number;
  wastageCost: number;
  occurrences: number;
  reasons: string[];
}

export interface FoodCostRow {
  siteId: string;
  siteName: string;
  covers: number;
  actualCost: number;
  expectedCost: number;
  wastageCost: number;
  costPerCover: number | null;
  foodCostPct: number | null;
}

const enabled = (p: Period) => !!p.from && !!p.to;

export function useConsumptionVariance(p: Period) {
  return useQuery<VarianceRow[]>({
    queryKey: ['reports', 'variance', p],
    queryFn: () =>
      apiFetch<VarianceRow[]>('/reports/consumption-variance', {
        searchParams: { from: p.from, to: p.to, siteId: p.siteId },
      }),
    enabled: enabled(p),
  });
}

export function useWastageReport(p: Period) {
  return useQuery<WastageRow[]>({
    queryKey: ['reports', 'wastage', p],
    queryFn: () =>
      apiFetch<WastageRow[]>('/reports/wastage', {
        searchParams: { from: p.from, to: p.to, siteId: p.siteId },
      }),
    enabled: enabled(p),
  });
}

export interface ExpiryBatch {
  batchId: string;
  batchCode: string;
  productId: string;
  productName: string;
  siteId: string;
  useBy: string | null;
  qtyRemaining: number;
  stockUom: string;
}

export interface ExpiryReport {
  expired: ExpiryBatch[];
  expiringSoon: ExpiryBatch[];
}

/** Batches expired / expiring within `withinDays` of `asOf` (P21). */
export function useExpiryReport(asOf: string, opts?: { siteId?: string; withinDays?: number }) {
  return useQuery<ExpiryReport>({
    queryKey: ['reports', 'expiry', asOf, opts ?? {}],
    queryFn: () =>
      apiFetch<ExpiryReport>('/reports/expiry', {
        searchParams: { asOf, siteId: opts?.siteId, withinDays: opts?.withinDays ?? 7 },
      }),
    enabled: !!asOf,
  });
}

export function useFoodCost(p: Period & { revenue?: number }) {
  return useQuery<FoodCostRow[]>({
    queryKey: ['reports', 'food-cost', p],
    queryFn: () =>
      apiFetch<FoodCostRow[]>('/reports/food-cost', {
        searchParams: { from: p.from, to: p.to, siteId: p.siteId, revenue: p.revenue },
      }),
    enabled: enabled(p),
  });
}
