/**
 * Entity pickers — thin wrappers that give EntityCombobox its data.
 *
 * Each one owns a search term, queries its own endpoint with it, and resolves
 * the label for an already-selected id so edit forms open showing the current
 * value rather than a blank box.
 *
 * All searches are server-side and capped at a single short page. The API's
 * product search already matches name, stock code and EAN, so typing part of a
 * SKU works without any backend change.
 */
import { useCallback, useState } from 'react';
import { EntityCombobox, MAX_VISIBLE_OPTIONS, type ComboboxOption } from './entity-combobox';
import { useProduct, useProductsList } from '@/features/products/use-products';
import { useCustomer, useCustomersList } from '@/features/customers/use-customers';
import { useSupplier, useSuppliersList } from '@/features/suppliers/use-suppliers';
import { useProductGroupsList } from '@/features/product-groups/use-product-groups';

/** Ask for one row more than we display, so "keep typing to narrow" is honest. */
const SEARCH_PAGE_SIZE = MAX_VISIBLE_OPTIONS + 1;

interface PickerProps {
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export function ProductPicker({ value, onChange, placeholder, ...rest }: PickerProps) {
  const [term, setTerm] = useState('');
  const onSearchTermChange = useCallback((t: string) => setTerm(t), []);

  const { data, isFetching } = useProductsList({
    search: term || undefined,
    pageSize: SEARCH_PAGE_SIZE,
  });

  // Resolve the selected product separately: it will usually not appear in the
  // current result set, because opening an edit form searches for nothing.
  const { data: selected } = useProduct(value);

  const options: ComboboxOption[] = (data?.data ?? []).map((p) => ({
    id: p.id,
    label: p.name,
    sublabel: p.stockCode,
  }));

  return (
    <EntityCombobox
      value={value}
      onChange={onChange}
      options={options}
      onSearchTermChange={onSearchTermChange}
      selectedLabel={selected ? `${selected.name}${selected.stockCode ? ` (${selected.stockCode})` : ''}` : null}
      isLoading={isFetching}
      placeholder={placeholder ?? 'Search by product name or SKU'}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export function CustomerPicker({ value, onChange, placeholder, ...rest }: PickerProps) {
  const [term, setTerm] = useState('');
  const onSearchTermChange = useCallback((t: string) => setTerm(t), []);

  const { data, isFetching } = useCustomersList({
    search: term || undefined,
    pageSize: SEARCH_PAGE_SIZE,
  });
  const { data: selected } = useCustomer(value);

  const options: ComboboxOption[] = (data?.data ?? []).map((c) => ({
    id: c.id,
    label: c.name,
    sublabel: c.email,
  }));

  return (
    <EntityCombobox
      value={value}
      onChange={onChange}
      options={options}
      onSearchTermChange={onSearchTermChange}
      selectedLabel={selected?.name ?? null}
      isLoading={isFetching}
      placeholder={placeholder ?? 'Search by customer name or email'}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Supplier
// ---------------------------------------------------------------------------

export function SupplierPicker({ value, onChange, placeholder, ...rest }: PickerProps) {
  const [term, setTerm] = useState('');
  const onSearchTermChange = useCallback((t: string) => setTerm(t), []);

  const { data, isFetching } = useSuppliersList({
    search: term || undefined,
    pageSize: SEARCH_PAGE_SIZE,
  });
  const { data: selected } = useSupplier(value);

  const options: ComboboxOption[] = (data?.data ?? []).map((s) => ({
    id: s.id,
    label: s.name,
    sublabel: s.email ?? null,
  }));

  return (
    <EntityCombobox
      value={value}
      onChange={onChange}
      options={options}
      onSearchTermChange={onSearchTermChange}
      selectedLabel={selected?.name ?? null}
      isLoading={isFetching}
      placeholder={placeholder ?? 'Search by supplier name'}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Product group
// ---------------------------------------------------------------------------

/**
 * Groups are the one list the API returns whole, with no search parameter, so
 * this filters client-side. Same interaction as the others — if the endpoint
 * gains pagination later, only this function changes.
 */
export function ProductGroupPicker({ value, onChange, placeholder, ...rest }: PickerProps) {
  const [term, setTerm] = useState('');
  const onSearchTermChange = useCallback((t: string) => setTerm(t), []);

  const { data: groups, isFetching } = useProductGroupsList();

  const needle = term.trim().toLowerCase();
  const options: ComboboxOption[] = (groups ?? [])
    .filter((g) =>
      needle === ''
        ? true
        : `${g.name} ${g.slug ?? ''}`.toLowerCase().includes(needle),
    )
    .map((g) => ({ id: g.id, label: g.name, sublabel: g.slug }));

  const selected = (groups ?? []).find((g) => g.id === value);

  return (
    <EntityCombobox
      value={value}
      onChange={onChange}
      options={options}
      onSearchTermChange={onSearchTermChange}
      selectedLabel={selected?.name ?? null}
      isLoading={isFetching}
      placeholder={placeholder ?? 'Search product groups'}
      {...rest}
    />
  );
}
