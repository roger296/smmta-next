import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface XeroAccountMapRow {
  role: string;
  xeroAccountCode: string;
  xeroTaxType: string;
  defaultCode?: string;
}

export interface XeroAccountMapEntry {
  role: string;
  xeroAccountCode: string;
  xeroTaxType?: string;
}

const KEY = ['xero-account-map'] as const;

export function useXeroAccountMap() {
  return useQuery<XeroAccountMapRow[]>({
    queryKey: KEY,
    queryFn: () => apiFetch<XeroAccountMapRow[]>('/xero/account-map'),
  });
}

export function useSaveXeroAccountMap() {
  const qc = useQueryClient();
  return useMutation<XeroAccountMapRow[], Error, XeroAccountMapEntry[]>({
    mutationFn: (entries) =>
      apiFetch<XeroAccountMapRow[]>('/xero/account-map', { method: 'PUT', body: { entries } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
