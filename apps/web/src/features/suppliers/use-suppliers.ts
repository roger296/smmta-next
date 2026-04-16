import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { createResourceHooks } from '../_shared/create-resource-hooks';
import type {
  Supplier,
  SupplierAddress,
  SupplierContact,
  SupplierNote,
} from '@/lib/api-types';

export interface SupplierListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  type?: string;
}

export interface CreateSupplierInput {
  name: string;
  type?: string;
  email?: string;
  accountsEmail?: string;
  website?: string;
  currencyCode?: string;
  creditLimit?: number;
  creditTermDays?: number;
  taxRatePercent?: number;
  vatTreatment?: string;
  vatRegistrationNumber?: string;
  countryCode?: string;
  leadTimeDays?: number;
  defaultExpenseAccountCode?: string;
}

const base = createResourceHooks<Supplier, CreateSupplierInput, Partial<CreateSupplierInput>, SupplierListQuery>({
  basePath: '/suppliers',
  queryKey: 'suppliers',
});

export const supplierKeys = base.keys;
export const useSuppliersList = base.useList;
export const useSupplier = base.useOne;
export const useCreateSupplier = base.useCreate;
export const useUpdateSupplier = base.useUpdate;
export const useDeleteSupplier = base.useDelete;

// ============================================================
// Contacts, addresses, notes
// ============================================================

export interface SupplierDetail extends Supplier {
  contacts?: SupplierContact[];
  addresses?: SupplierAddress[];
  notes?: SupplierNote[];
}

export function useAddSupplierContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      supplierId,
      input,
    }: {
      supplierId: string;
      input: Record<string, string | undefined>;
    }) =>
      apiFetch<SupplierContact>(`/suppliers/${supplierId}/contacts`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (_data, { supplierId }) => {
      qc.invalidateQueries({ queryKey: ['suppliers', 'detail', supplierId] });
    },
  });
}

export function useDeleteSupplierContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, contactId }: { supplierId: string; contactId: string }) =>
      apiFetch<void>(`/suppliers/${supplierId}/contacts/${contactId}`, { method: 'DELETE' }),
    onSuccess: (_data, { supplierId }) => {
      qc.invalidateQueries({ queryKey: ['suppliers', 'detail', supplierId] });
    },
  });
}

export function useAddSupplierAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      supplierId,
      input,
    }: {
      supplierId: string;
      input: Record<string, unknown>;
    }) =>
      apiFetch<SupplierAddress>(`/suppliers/${supplierId}/addresses`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (_data, { supplierId }) => {
      qc.invalidateQueries({ queryKey: ['suppliers', 'detail', supplierId] });
    },
  });
}

export function useDeleteSupplierAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, addressId }: { supplierId: string; addressId: string }) =>
      apiFetch<void>(`/suppliers/${supplierId}/addresses/${addressId}`, { method: 'DELETE' }),
    onSuccess: (_data, { supplierId }) => {
      qc.invalidateQueries({ queryKey: ['suppliers', 'detail', supplierId] });
    },
  });
}

export function useAddSupplierNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      supplierId,
      input,
    }: {
      supplierId: string;
      input: { note: string; attachmentUrl?: string; isMarked?: boolean };
    }) =>
      apiFetch<SupplierNote>(`/suppliers/${supplierId}/notes`, { method: 'POST', body: input }),
    onSuccess: (_data, { supplierId }) => {
      qc.invalidateQueries({ queryKey: ['suppliers', 'detail', supplierId] });
    },
  });
}

