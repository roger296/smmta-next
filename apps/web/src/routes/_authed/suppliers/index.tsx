import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, Pagination } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/empty-state';
import { useSuppliersList } from '@/features/suppliers/use-suppliers';
import { useDebounce } from '@/hooks/use-debounce';
import type { Supplier } from '@/lib/api-types';
import { formatMoney } from '@/lib/format';
import { Plus, Truck } from 'lucide-react';

export const Route = createFileRoute('/_authed/suppliers/')({
  component: SuppliersListPage,
});

const columns: ColumnDef<Supplier>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'type', header: 'Type', cell: ({ getValue }) => getValue<string>() ?? '—' },
  { accessorKey: 'email', header: 'Email', cell: ({ getValue }) => getValue<string>() ?? '—' },
  { accessorKey: 'currencyCode', header: 'Currency' },
  {
    accessorKey: 'creditLimit',
    header: 'Credit limit',
    cell: ({ row }) => formatMoney(row.original.creditLimit, row.original.currencyCode),
  },
];

function SuppliersListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const debounced = useDebounce(search, 300);
  const [page, setPage] = React.useState(1);
  const pageSize = 25;

  const { data, isLoading, isError, error } = useSuppliersList({
    page,
    pageSize,
    search: debounced || undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Suppliers</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Manage supplier accounts and purchase records.
          </p>
        </div>
        <Button asChild>
          <Link to="/suppliers/new">
            <Plus className="h-4 w-4" />
            New supplier
          </Link>
        </Button>
      </div>

      <Input
        placeholder="Search by name or type…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        aria-label="Search suppliers"
        className="max-w-sm"
      />

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}
      {isError && (
        <Card>
          <CardContent className="p-6" role="alert">
            <p className="text-sm text-[var(--color-destructive)]">
              Failed to load: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </CardContent>
        </Card>
      )}
      {!isLoading && !isError && data && data.data.length === 0 && (
        <EmptyState
          icon={Truck}
          title={debounced ? 'No suppliers match your search' : 'No suppliers yet'}
          action={
            !debounced && (
              <Button asChild>
                <Link to="/suppliers/new">
                  <Plus className="h-4 w-4" />
                  New supplier
                </Link>
              </Button>
            )
          }
        />
      )}
      {!isLoading && !isError && data && data.data.length > 0 && (
        <div className="space-y-4">
          <DataTable
            columns={columns}
            data={data.data}
            onRowClick={(row) => navigate({ to: '/suppliers/$id', params: { id: row.id } })}
          />
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
