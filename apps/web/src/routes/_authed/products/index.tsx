import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { DataTable, Pagination } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/empty-state';
import { useProductsList } from '@/features/products/use-products';
import { useDebounce } from '@/hooks/use-debounce';
import type { Product } from '@/lib/api-types';
import { formatMoney } from '@/lib/format';
import { Package, Plus } from 'lucide-react';

export const Route = createFileRoute('/_authed/products/')({
  component: ProductsListPage,
});

const columns: ColumnDef<Product>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'stockCode', header: 'Stock code', cell: ({ getValue }) => getValue<string>() ?? '—' },
  {
    accessorKey: 'productType',
    header: 'Type',
    cell: ({ getValue }) => (
      <Badge variant={getValue<string>() === 'SERVICE' ? 'secondary' : 'outline'}>
        {getValue<string>()}
      </Badge>
    ),
  },
  {
    accessorKey: 'expectedNextCost',
    header: 'Next cost',
    cell: ({ getValue }) => formatMoney(getValue<string>(), 'GBP'),
  },
  {
    accessorKey: 'minSellingPrice',
    header: 'Min price',
    cell: ({ getValue }) => formatMoney(getValue<string>() ?? undefined, 'GBP'),
  },
];

function ProductsListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const debounced = useDebounce(search, 300);
  const [page, setPage] = React.useState(1);
  const pageSize = 25;

  const { data, isLoading, isError, error } = useProductsList({
    page,
    pageSize,
    search: debounced || undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Manage product catalogue, pricing and stock settings.
          </p>
        </div>
        <Button asChild>
          <Link to="/products/new">
            <Plus className="h-4 w-4" />
            New product
          </Link>
        </Button>
      </div>

      <Input
        placeholder="Search by name, SKU or EAN…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        aria-label="Search products"
        className="max-w-sm"
      />

      {isLoading && <Skeleton className="h-64 w-full" />}
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
          icon={Package}
          title={debounced ? 'No products match your search' : 'No products yet'}
          action={
            !debounced && (
              <Button asChild>
                <Link to="/products/new">
                  <Plus className="h-4 w-4" />
                  New product
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
            onRowClick={(row) => navigate({ to: '/products/$id', params: { id: row.id } })}
          />
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
