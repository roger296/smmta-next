import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface CategoryTreeNode {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  isHidden: boolean;
  sortOrder: number;
  productCount: number;
  children: Array<{
    id: string;
    slug: string | null;
    name: string;
    productCount: number;
    sortOrder: number;
  }>;
}

/** Hierarchical category tree + product counts. Used by the admin
 *  SPA's Categories page to show the operator the shape of the
 *  taxonomy. */
export function useCategoryTree() {
  return useQuery<CategoryTreeNode[]>({
    queryKey: ['categories', 'tree'],
    queryFn: () => apiFetch<CategoryTreeNode[]>('/categories/tree'),
  });
}
