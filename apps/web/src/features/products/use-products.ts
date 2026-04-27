import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { createResourceHooks } from '../_shared/create-resource-hooks';
import type { Product, ProductImage, StockLevel } from '@/lib/api-types';

export interface ProductListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  categoryId?: string;
  manufacturerId?: string;
  productType?: 'PHYSICAL' | 'SERVICE';
  supplierId?: string;
}

export interface CreateProductInput {
  name: string;
  stockCode?: string;
  manufacturerId?: string;
  manufacturerPartNumber?: string;
  description?: string;
  expectedNextCost?: number;
  minSellingPrice?: number;
  maxSellingPrice?: number;
  ean?: string;
  productType?: 'PHYSICAL' | 'SERVICE';
  requireSerialNumber?: boolean;
  requireBatchNumber?: boolean;
  weight?: number;
  countryOfOrigin?: string;
  hsCode?: string;
  supplierId?: string;
  defaultWarehouseId?: string;
  // Storefront fields. All optional — set them via the Storefront tab.
  groupId?: string | null;
  colour?: string | null;
  colourHex?: string | null;
  slug?: string | null;
  shortDescription?: string | null;
  longDescription?: string | null;
  heroImageUrl?: string | null;
  galleryImageUrls?: string[] | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string[] | null;
  isPublished?: boolean;
  sortOrderInGroup?: number;
}

const base = createResourceHooks<Product, CreateProductInput, Partial<CreateProductInput>, ProductListQuery>({
  basePath: '/products',
  queryKey: 'products',
});

export const productKeys = base.keys;
export const useProductsList = base.useList;
export const useProduct = base.useOne;
export const useCreateProduct = base.useCreate;
export const useUpdateProduct = base.useUpdate;
export const useDeleteProduct = base.useDelete;

// ============================================================
// Stock levels per product
// ============================================================

export function useProductStockLevel(productId: string | undefined) {
  return useQuery<StockLevel[]>({
    queryKey: ['products', 'detail', productId, 'stock-level'],
    queryFn: () => apiFetch<StockLevel[]>(`/products/${productId}/stock-level`),
    enabled: !!productId,
  });
}

// ============================================================
// Images
// ============================================================

export function useProductImages(productId: string | undefined) {
  return useQuery<ProductImage[]>({
    queryKey: ['products', 'detail', productId, 'images'],
    queryFn: () => apiFetch<ProductImage[]>(`/products/${productId}/images`),
    enabled: !!productId,
  });
}

export function useAddProductImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      productId,
      input,
    }: {
      productId: string;
      input: { imageUrl: string; priority?: number };
    }) =>
      apiFetch<ProductImage>(`/products/${productId}/images`, { method: 'POST', body: input }),
    onSuccess: (_data, { productId }) => {
      qc.invalidateQueries({ queryKey: ['products', 'detail', productId, 'images'] });
    },
  });
}

export function useDeleteProductImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, imageId }: { productId: string; imageId: string }) =>
      apiFetch<void>(`/products/${productId}/images/${imageId}`, { method: 'DELETE' }),
    onSuccess: (_data, { productId }) => {
      qc.invalidateQueries({ queryKey: ['products', 'detail', productId, 'images'] });
    },
  });
}

// ============================================================
// Category assignment
// ============================================================

export function useAssignCategoryToProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, productId }: { categoryId: string; productId: string }) =>
      apiFetch<void>(`/categories/${categoryId}/products/${productId}`, { method: 'POST' }),
    onSuccess: (_data, { productId }) => {
      qc.invalidateQueries({ queryKey: ['products', 'detail', productId] });
    },
  });
}

export function useRemoveCategoryFromProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, productId }: { categoryId: string; productId: string }) =>
      apiFetch<void>(`/categories/${categoryId}/products/${productId}`, { method: 'DELETE' }),
    onSuccess: (_data, { productId }) => {
      qc.invalidateQueries({ queryKey: ['products', 'detail', productId] });
    },
  });
}
