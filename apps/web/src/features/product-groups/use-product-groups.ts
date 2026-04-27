/**
 * Product groups: hand-rolled non-paginated hooks (the catalogue is small —
 * ~12 groups in the v1 architecture). Mirrors the manufacturer / warehouse
 * pattern in `use-reference.ts`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Product, ProductGroup } from '@/lib/api-types';

export interface CreateProductGroupInput {
  name: string;
  description?: string | null;
  groupType?: string | null;
  slug?: string | null;
  shortDescription?: string | null;
  longDescription?: string | null;
  heroImageUrl?: string | null;
  galleryImageUrls?: string[] | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string[] | null;
  isPublished?: boolean;
  sortOrder?: number;
}

export type UpdateProductGroupInput = Partial<CreateProductGroupInput>;

export type ProductGroupWithProducts = ProductGroup & { products?: Product[] };

const KEY = 'product-groups';

export function useProductGroupsList() {
  return useQuery<ProductGroup[]>({
    queryKey: [KEY],
    queryFn: () => apiFetch<ProductGroup[]>('/product-groups'),
  });
}

export function useProductGroup(id: string | undefined) {
  return useQuery<ProductGroupWithProducts>({
    queryKey: [KEY, 'detail', id],
    queryFn: () => apiFetch<ProductGroupWithProducts>(`/product-groups/${id}`),
    enabled: !!id,
  });
}

export function useCreateProductGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProductGroupInput) =>
      apiFetch<ProductGroup>('/product-groups', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateProductGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateProductGroupInput }) =>
      apiFetch<ProductGroup>(`/product-groups/${id}`, { method: 'PUT', body: input }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: [KEY, 'detail', vars.id] });
    },
  });
}

export function useDeleteProductGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/product-groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
