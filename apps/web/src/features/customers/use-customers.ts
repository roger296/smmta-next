import { useQuery } from '@tanstack/react-query';
import { apiFetch, type PaginatedResult } from '@/lib/api-client';
import type { Customer, CustomerListQuery } from '@/lib/api-types';

export const customerKeys = {
  all: ['customers'] as const,
  lists: () => [...customerKeys.all, 'list'] as const,
  list: (params: CustomerListQuery) => [...customerKeys.lists(), params] as const,
  details: () => [...customerKeys.all, 'detail'] as const,
  detail: (id: string) => [...customerKeys.details(), id] as const,
};

export function useCustomersList(params: CustomerListQuery = {}) {
  return useQuery({
    queryKey: customerKeys.list(params),
    queryFn: () =>
      apiFetch<PaginatedResult<Customer>>('/customers', {
        searchParams: {
          page: params.page,
          pageSize: params.pageSize,
          search: params.search,
          customerTypeId: params.customerTypeId,
          isActive: params.isActive,
        },
      }),
  });
}
