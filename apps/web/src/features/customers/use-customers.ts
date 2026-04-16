import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { createResourceHooks } from '../_shared/create-resource-hooks';
import type {
  Customer,
  CustomerContact,
  CustomerDeliveryAddress,
  CustomerInvoiceAddress,
  CustomerNote,
  CustomerType,
} from '@/lib/api-types';

export interface CustomerListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  typeId?: string;
}

export interface CreateCustomerInput {
  name: string;
  shortName?: string;
  typeId?: string;
  email?: string;
  creditLimit?: number;
  creditCurrencyCode?: string;
  creditTermDays?: number;
  taxRatePercent?: number;
  vatTreatment?: string;
  vatRegistrationNumber?: string;
  companyRegistrationNumber?: string;
  countryCode?: string;
  defaultRevenueAccountCode?: string;
  warehouseId?: string;
}

const base = createResourceHooks<Customer, CreateCustomerInput, Partial<CreateCustomerInput>, CustomerListQuery>({
  basePath: '/customers',
  queryKey: 'customers',
});

export const customerKeys = base.keys;
export const useCustomersList = base.useList;
export const useCustomer = base.useOne;
export const useCreateCustomer = base.useCreate;
export const useUpdateCustomer = base.useUpdate;
export const useDeleteCustomer = base.useDelete;

// ============================================================
// Related: contacts, addresses, notes
// ============================================================

export interface CustomerDetail extends Customer {
  contacts?: CustomerContact[];
  deliveryAddresses?: CustomerDeliveryAddress[];
  invoiceAddresses?: CustomerInvoiceAddress[];
  notes?: CustomerNote[];
}

export function useCustomerContacts(customerId: string | undefined) {
  return useQuery<CustomerContact[]>({
    queryKey: ['customers', 'detail', customerId, 'contacts'],
    queryFn: async () => {
      const detail = await apiFetch<CustomerDetail>(`/customers/${customerId}`);
      return detail.contacts ?? [];
    },
    enabled: !!customerId,
  });
}

export function useAddCustomerContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, input }: { customerId: string; input: Record<string, string | undefined> }) =>
      apiFetch<CustomerContact>(`/customers/${customerId}/contacts`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (_data, { customerId }) => {
      qc.invalidateQueries({ queryKey: ['customers', 'detail', customerId] });
    },
  });
}

export function useUpdateCustomerContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      contactId,
      input,
    }: {
      customerId: string;
      contactId: string;
      input: Record<string, string | undefined>;
    }) =>
      apiFetch<CustomerContact>(`/customers/${customerId}/contacts/${contactId}`, {
        method: 'PUT',
        body: input,
      }),
    onSuccess: (_data, { customerId }) => {
      qc.invalidateQueries({ queryKey: ['customers', 'detail', customerId] });
    },
  });
}

export function useDeleteCustomerContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, contactId }: { customerId: string; contactId: string }) =>
      apiFetch<void>(`/customers/${customerId}/contacts/${contactId}`, { method: 'DELETE' }),
    onSuccess: (_data, { customerId }) => {
      qc.invalidateQueries({ queryKey: ['customers', 'detail', customerId] });
    },
  });
}

export function useAddCustomerDeliveryAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      input,
    }: {
      customerId: string;
      input: Record<string, unknown>;
    }) =>
      apiFetch<CustomerDeliveryAddress>(`/customers/${customerId}/addresses/delivery`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (_data, { customerId }) => {
      qc.invalidateQueries({ queryKey: ['customers', 'detail', customerId] });
    },
  });
}

export function useDeleteCustomerDeliveryAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, addressId }: { customerId: string; addressId: string }) =>
      apiFetch<void>(`/customers/${customerId}/addresses/delivery/${addressId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, { customerId }) => {
      qc.invalidateQueries({ queryKey: ['customers', 'detail', customerId] });
    },
  });
}

export function useAddCustomerNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      input,
    }: {
      customerId: string;
      input: { note: string; attachmentUrl?: string; isMarked?: boolean };
    }) =>
      apiFetch<CustomerNote>(`/customers/${customerId}/notes`, { method: 'POST', body: input }),
    onSuccess: (_data, { customerId }) => {
      qc.invalidateQueries({ queryKey: ['customers', 'detail', customerId] });
    },
  });
}

// ============================================================
// Customer types (reference data)
// ============================================================

export function useCustomerTypes() {
  return useQuery<CustomerType[]>({
    queryKey: ['customer-types'],
    queryFn: () => apiFetch<CustomerType[]>('/customer-types'),
  });
}

export function useCreateCustomerType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; isDefault?: boolean }) =>
      apiFetch<CustomerType>('/customer-types', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customer-types'] }),
  });
}

export function useUpdateCustomerType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      typeId,
      input,
    }: {
      typeId: string;
      input: { name?: string; isDefault?: boolean };
    }) =>
      apiFetch<CustomerType>(`/customer-types/${typeId}`, { method: 'PUT', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customer-types'] }),
  });
}

export function useDeleteCustomerType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (typeId: string) =>
      apiFetch<void>(`/customer-types/${typeId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customer-types'] }),
  });
}
