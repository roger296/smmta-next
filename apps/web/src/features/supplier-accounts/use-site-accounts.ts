import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

export interface SiteAccount {
  id: string;
  supplierId: string;
  siteId: string;
  accountNumber: string | null;
  ediLocationId: string | null;
  deliveryDays: string[];
  /** "HH:MM:SS" from Postgres, or null. */
  cutoffTime: string | null;
  cutoffDaysBefore: number;
  leadDays: number | null;
  minOrderValue: string | null;
  deliveryCharge: string | null;
  freeDeliveryOver: string | null;
  orderEmail: string | null;
  portalUrl: string | null;
  notes: string | null;
  isActive: boolean;
}

export interface SiteAccountView {
  site: { id: string; name: string; timezone: string };
  account: SiteAccount | null;
  nextDelivery: { deliveryDate: string; orderByLocal: string | null; basis: 'ROUND' | 'LEAD_TIME' } | null;
}

export interface SiteAccountInput {
  accountNumber?: string | null;
  ediLocationId?: string | null;
  deliveryDays?: string[];
  cutoffTime?: string | null;
  cutoffDaysBefore?: number;
  leadDays?: number | null;
  minOrderValue?: number | null;
  deliveryCharge?: number | null;
  freeDeliveryOver?: number | null;
  orderEmail?: string | null;
  portalUrl?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export function useSiteAccounts(supplierId: string) {
  return useQuery<SiteAccountView[]>({
    queryKey: ['supplier-site-accounts', supplierId],
    queryFn: () => apiFetch<SiteAccountView[]>(`/suppliers/${supplierId}/site-accounts`),
  });
}

export function useSaveSiteAccount(supplierId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ siteId, input }: { siteId: string; input: SiteAccountInput }) =>
      apiFetch<SiteAccount>(`/suppliers/${supplierId}/site-accounts/${siteId}`, { method: 'PUT', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supplier-site-accounts', supplierId] }),
  });
}
