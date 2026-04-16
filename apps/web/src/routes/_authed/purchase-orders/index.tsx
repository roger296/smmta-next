import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { DELIVERY_STATUSES, usePurchaseOrdersList } from '@/features/purchasing/use-purchasing';
import { useDebounce } from '@/hooks/use-debounce';
import type { PODeliveryStatus, PurchaseOrder } from '@/lib/api-types';
import { formatDate, formatMoney } from '@/lib/format';
import { Plus, Receipt } from 'lucide-react';

export const Route = createFileRoute('/_authed/purchase-orders/')({
  component: PurchaseOrdersListPage,
});

const columns: ColumnDef<PurchaseOrder>[] = [
  { accessorKey: 'poNumber', header: 'PO #' },
  {
    accessorKey: 'supplierName',
    header: 'Supplier',
    cell: ({ row }) => row.original.supplierName ?? row.original.supplierId.slice(0, 8),
  },
  { accessorKey: 'createdAt', header: 'Date', cell: ({ getValue }) => formatDate(getValue<string>()) },
  {
    accessorKey: 'deliveryStatus',
    header: 'Delivery',
    cell: ({ getValue }) => {
      const s = getValue<PODeliveryStatus>();
      const meta = DELIVERY_STATUSES.find((x) => x.value === s);
      return (
        <Badge variant={(meta?.color ?? 'outline') as 'default' | 'secondary' | 'destructive' | 'outline'}>
          {meta?.label ?? s}
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

function PurchaseOrdersListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const debounced = useDebounce(search, 300);
  const [status, setStatus] = React.useState<PODeliveryStatus | ''>('');
  const [page, setPage] = React.useState(1);
  const pageSize = 25;

  const { data, isLoading } = usePurchaseOrdersList({
    page,
    pageSize,
    search: debounced || undefined,
    deliveryStatus: status || undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Purchase orders</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Orders placed with suppliers.
          </p>
        </div>
        <Button asChild>
          <Link to="/purchase-orders/new">
            <Plus className="h-4 w-4" />
            New PO
          </Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by PO number…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          aria-label="Search purchase orders"
          className="max-w-sm"
        />
        <Select
          value={status || 'all'}
          onValueChange={(v) => {
            setStatus(v === 'all' ? '' : (v as PODeliveryStatus));
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48" aria-label="Filter by delivery status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {DELIVERY_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isLoading && <Skeleton className="h-64 w-full" />}
      {!isLoading && data && data.data.length === 0 && (
        <EmptyState
          icon={Receipt}
          title={debounced || status ? 'No POs match your filters' : 'No purchase orders yet'}
          action={
            !debounced && !status ? (
              <Button asChild>
                <Link to="/purchase-orders/new">
                  <Plus className="h-4 w-4" />
                  New PO
                </Link>
              </Button>
            ) : undefined
          }
        />
      )}
      {!isLoading && data && data.data.length > 0 && (
        <div className="space-y-4">
          <DataTable
            columns={columns}
            data={data.data}
            onRowClick={(row) => navigate({ to: '/purchase-orders/$id', params: { id: row.id } })}
          />
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
