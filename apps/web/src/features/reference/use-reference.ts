/**
 * Reference data hooks: warehouses, categories, manufacturers.
 * All three use simple list-only endpoints (no pagination).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Category, Manufacturer, Warehouse } from '@/lib/api-types';

// ============================================================
// Warehouses
// ============================================================

export function useWarehouses() {
  return useQuery<Warehouse[]>({
    queryKey: ['warehouses'],
    queryFn: () => apiFetch<Warehouse[]>('/warehouses'),
  });
}

export interface CreateWarehouseInput {
  name: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postCode?: string;
  country?: string;
  isDefault?: boolean;
}

export function useCreateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWarehouseInput) =>
      apiFetch<Warehouse>('/warehouses', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouses'] }),
  });
}

export function useUpdateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<CreateWarehouseInput> }) =>
      apiFetch<Warehouse>(`/warehouses/${id}`, { method: 'PUT', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouses'] }),
  });
}

export function useDeleteWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/warehouses/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouses'] }),
  });
}

// ============================================================
// Categories
// ============================================================

export function useCategories(search?: string) {
  return useQuery<Category[]>({
    queryKey: ['categories', { search }],
    queryFn: () => apiFetch<Category[]>('/categories', { searchParams: { search } }),
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) =>
      apiFetch<Category>('/categories', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: { name: string } }) =>
      apiFetch<Category>(`/categories/${id}`, { method: 'PUT', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
}

// ============================================================
// Manufacturers
// ============================================================

export function useManufacturers() {
  return useQuery<Manufacturer[]>({
    queryKey: ['manufacturers'],
    queryFn: () => apiFetch<Manufacturer[]>('/manufacturers'),
  });
}

export interface CreateManufacturerInput {
  name: string;
  description?: string;
  logoUrl?: string;
  website?: string;
  customerSupportPhone?: string;
  customerSupportEmail?: string;
  techSupportPhone?: string;
  techSupportEmail?: string;
}

export function useCreateManufacturer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateManufacturerInput) =>
      apiFetch<Manufacturer>('/manufacturers', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['manufacturers'] }),
  });
}

export function useUpdateManufacturer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<CreateManufacturerInput> }) =>
      apiFetch<Manufacturer>(`/manufacturers/${id}`, { method: 'PUT', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['manufacturers'] }),
  });
}

export function useDeleteManufacturer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/manufacturers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['manufacturers'] }),
  });
}
