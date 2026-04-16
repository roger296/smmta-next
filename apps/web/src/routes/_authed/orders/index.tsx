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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ORDER_STATUSES, useOrdersList } from '@/features/orders/use-orders';
import { useDebounce } from '@/hooks/use-debounce';
import type { Order, OrderStatus } from '@/lib/api-types';
import { formatDate, formatMoney } from '@/lib/format';
import { Plus, ShoppingCart } from 'lucide-react';

export const Route = createFileRoute('/_authed/orders/')({
  component: OrdersListPage,
});

const columns: ColumnDef<Order>[] = [
  { accessorKey: 'orderNumber', header: 'Order #' },
  {
    accessorKey: 'customerName',
    header: 'Customer',
    cell: ({ row }) => row.original.customerName ?? row.original.customerId.slice(0, 8),
  },
  { accessorKey: 'orderDate', header: 'Date', cell: ({ getValue }) => formatDate(getValue<string>()) },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ getValue }) => {
      const status = getValue<OrderStatus>();
      const meta = ORDER_STATUSES.find((s) => s.value === status);
      return (
        <Badge variant={(meta?.color ?? 'outline') as 'default' | 'secondary' | 'destructive' | 'outline'}>
          {meta?.label ?? status}
        </Badge>
      );
    },
  },
  {
    accessorKey: 'total',
    header: 'Total',
    cell: ({ row }) => formatMoney(row.original.total, row.original.currencyCode),
  },
];

function OrdersListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<OrderStatus | ''>('');
  const debounced = useDebounce(search, 300);
  const [page, setPage] = React.useState(1);
  const pageSize = 25;

  const { data, isLoading, isError, error } = useOrdersList({
    page,
    pageSize,
    search: debounced || undefined,
    status: status || undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Orders</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Customer orders, allocation and invoicing.
          </p>
        </div>
        <Button asChild>
          <Link to="/orders/new">
            <Plus className="h-4 w-4" />
            New order
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by order number or customer PO…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          aria-label="Search orders"
          className="max-w-sm"
        />
        <Select
          value={status || 'all'}
          onValueChange={(v) => {
            setStatus(v === 'all' ? '' : (v as OrderStatus));
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {ORDER_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading && <Skeleton className="h-64 w-full" />}
      {isError && (
        <Card>
          <CardContent className="p-6" role="alert">
            <p className="text-sm text-[var(--color-destructive)]">
              Failed to load: {error instanceof Error ? error.message : 'Unknown'}
            </p>
          </CardContent>
        </Card>
      )}
      {!isLoading && !isError && data && data.data.length === 0 && (
        <EmptyState
          icon={ShoppingCart}
          title={debounced || status ? 'No orders match your filters' : 'No orders yet'}
          action={
            !debounced && !status ? (
              <Button asChild>
                <Link to="/orders/new">
                  <Plus className="h-4 w-4" />
                  New order
                </Link>
              </Button>
            ) : undefined
          }
        />
      )}
      {!isLoading && !isError && data && data.data.length > 0 && (
        <div className="space-y-4">
          <DataTable
            columns={columns}
            data={data.data}
            onRowClick={(row) => navigate({ to: '/orders/$id', params: { id: row.id } })}
          />
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
