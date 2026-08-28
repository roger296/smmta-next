import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
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
import { STOCK_STATUSES, useStockItemsList } from '@/features/stock/use-stock';
import { useWarehouses } from '@/features/reference/use-reference';
import type { StockItem, StockItemStatus } from '@/lib/api-types';
import { formatMoney } from '@/lib/format';
import { Warehouse } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useDebounce } from '@/hooks/use-debounce';

export const Route = createFileRoute('/_authed/stock/')({
  component: StockItemsListPage,
});

const columns: ColumnDef<StockItem>[] = [
  {
    accessorKey: 'productName',
    header: 'Product',
    cell: ({ row }) => row.original.product?.name ?? row.original.productId.slice(0, 8),
  },
  {
    accessorKey: 'warehouseName',
    header: 'Warehouse',
    cell: ({ row }) => row.original.warehouse?.name ?? row.original.warehouseId.slice(0, 8),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ getValue }) => {
      const s = getValue<StockItemStatus>();
      const meta = STOCK_STATUSES.find((x) => x.value === s);
      return (
        <Badge variant={(meta?.color ?? 'outline') as 'default' | 'secondary' | 'destructive' | 'outline'}>
          {meta?.label ?? s}
        </Badge>
      );
    },
  },
  {
    accessorKey: 'serialNumber',
    header: 'Serial',
    cell: ({ getValue }) => getValue<string>() ?? '—',
  },
  {
    accessorKey: 'valuePerUnit',
    header: 'Value',
    cell: ({ row }) => formatMoney(row.original.value, row.original.currencyCode),
  },
];

function StockItemsListPage() {
  const { data: warehouses } = useWarehouses();
  const [search, setSearch] = React.useState('');
  const debounced = useDebounce(search, 300);
  const [warehouseId, setWarehouseId] = React.useState<string>('');
  const [status, setStatus] = React.useState<StockItemStatus | ''>('');
  const [page, setPage] = React.useState(1);
  const pageSize = 25;

  const { data, isLoading } = useStockItemsList({
    page,
    pageSize,
    search: debounced || undefined,
    warehouseId: warehouseId || undefined,
    status: status || undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Stock</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Individual stock items across warehouses.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/stock/adjust">Adjust stock</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/stock/transfer">Transfer</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/stock/report">Report</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/stock/serial">Find by serial</Link>
          </Button>
        </div>
      </div>

      {/* Stock rows carry no searchable text of their own, so this matches
          against the item's product — the same name / SKU / EAN fields the
          Products page searches, so the same text finds the same things. */}
      <Input
        placeholder="Search by product name, SKU or EAN…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        aria-label="Search stock by product"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={warehouseId || 'all'}
          onValueChange={(v) => {
            setWarehouseId(v === 'all' ? '' : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-56" aria-label="Filter by warehouse">
            <SelectValue placeholder="All warehouses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All warehouses</SelectItem>
            {warehouses?.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={status || 'all'}
          onValueChange={(v) => {
            setStatus(v === 'all' ? '' : (v as StockItemStatus));
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STOCK_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading && <Skeleton className="h-64 w-full" />}
      {!isLoading && data && data.data.length === 0 && (
        <EmptyState icon={Warehouse} title="No stock items" description="Book in a PO or add stock adjustment." />
      )}
      {!isLoading && data && data.data.length > 0 && (
        <div className="space-y-4">
          <DataTable columns={columns} data={data.data} />
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
