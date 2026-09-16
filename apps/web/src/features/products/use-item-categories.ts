import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ItemCategory {
  id: string;
  name: string;
  sortOrder: number;
  /** Live products carrying this category — shown so head office can see what
   *  a category is actually being used for before renaming or retiring it. */
  productCount: number;
}

const KEY = ['item-categories'] as const;

export function useItemCategories() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<ItemCategory[]>('/item-categories'),
  });
}

/**
 * Add a category from the product form.
 *
 * The API is idempotent on the name, so pressing Add twice — or two people
 * adding "Packaging" at once — returns the same category rather than an error
 * the operator has to interpret.
 */
export function useCreateItemCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<ItemCategory & { created: boolean }>('/item-categories', {
        method: 'POST',
        body: { name },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
