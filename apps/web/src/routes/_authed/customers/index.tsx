import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, Pagination } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/empty-state';
import { useCustomersList } from '@/features/customers/use-customers';
import { useDebounce } from '@/hooks/use-debounce';
import type { Customer } from '@/lib/api-types';
import { formatMoney } from '@/lib/format';
import { Plus, Users } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';

export const Route = createFileRoute('/_authed/customers/')({
  component: CustomersListPage,
});

const columns: ColumnDef<Customer>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'code', header: 'Code', cell: ({ getValue }) => getValue<string>() ?? '—' },
  { accessorKey: 'email', header: 'Email', cell: ({ getValue }) => getValue<string>() ?? '—' },
  {
    accessorKey: 'creditLimit',
    header: 'Credit limit',
    cell: ({ row }) => formatMoney(row.original.creditLimit, row.original.creditCurrencyCode),
  },
  { accessorKey: 'creditTermDays', header: 'Terms', cell: ({ getValue }) => `${getValue<number>()} days` },
];

function CustomersListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const debounced = useDebounce(search, 300);
  const [page, setPage] = React.useState(1);
  const pageSize = 25;

  const { data, isLoading, isError, error } = useCustomersList({
    page,
    pageSize,
    search: debounced || undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Customers</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Manage customer accounts and related records.
          </p>
        </div>
        <Button asChild>
          <Link to="/customers/new">
            <Plus className="h-4 w-4" />
            New customer
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by name, code or email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          aria-label="Search customers"
          className="max-w-sm"
        />
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}

      {isError && (
        <Card>
          <CardContent className="p-6" role="alert">
            <p className="text-sm text-[var(--color-destructive)]">
              Failed to load customers: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && data && data.data.length === 0 && (
        <EmptyState
          icon={Users}
          title={debounced ? 'No customers match your search' : 'No customers yet'}
          description={debounced ? 'Try a different keyword.' : 'Create your first customer to get started.'}
          action={
            !debounced && (
              <Button asChild>
                <Link to="/customers/new">
                  <Plus className="h-4 w-4" />
                  New customer
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
            onRowClick={(row) => navigate({ to: '/customers/$id', params: { id: row.id } })}
          />
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
