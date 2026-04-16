import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { DataTable, Pagination } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/empty-state';
import { INVOICE_STATUSES } from '@/features/invoices/use-invoices';
import { useSupplierInvoicesList } from '@/features/purchasing/use-purchasing';
import type { InvoiceStatus, SupplierInvoice } from '@/lib/api-types';
import { formatDate, formatMoney } from '@/lib/format';
import { Receipt } from 'lucide-react';

export const Route = createFileRoute('/_authed/supplier-invoices/')({
  component: SupplierInvoicesListPage,
});

const columns: ColumnDef<SupplierInvoice>[] = [
  { accessorKey: 'invoiceNumber', header: 'Invoice #' },
  {
    accessorKey: 'supplierName',
    header: 'Supplier',
    cell: ({ row }) => row.original.supplierName ?? row.original.supplierId.slice(0, 8),
  },
  { accessorKey: 'dateOfInvoice', header: 'Date', cell: ({ getValue }) => formatDate(getValue<string>()) },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ getValue }) => {
      const s = getValue<InvoiceStatus>();
      const meta = INVOICE_STATUSES.find((x) => x.value === s);
      return (
        <Badge variant={(meta?.color ?? 'outline') as 'default' | 'secondary' | 'destructive' | 'outline'}>
          {meta?.label ?? s}
        </Badge>
      );
    },
  },
  { accessorKey: 'total', header: 'Total', cell: ({ getValue }) => formatMoney(getValue<string>()) },
  {
    accessorKey: 'outstandingAmount',
    header: 'Outstanding',
    cell: ({ getValue }) => formatMoney(getValue<string>()),
  },
];

function SupplierInvoicesListPage() {
  const navigate = useNavigate();
  const [page, setPage] = React.useState(1);
  const pageSize = 25;

  const { data, isLoading } = useSupplierInvoicesList({ page, pageSize });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Supplier invoices</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Bills received from suppliers.
        </p>
      </div>
      {isLoading && <Skeleton className="h-64 w-full" />}
      {!isLoading && data && data.data.length === 0 && (
        <EmptyState
          icon={Receipt}
          title="No supplier invoices yet"
          description="Create a supplier invoice from a PO."
        />
      )}
      {!isLoading && data && data.data.length > 0 && (
        <div className="space-y-4">
          <DataTable
            columns={columns}
            data={data.data}
            onRowClick={(row) => navigate({ to: '/supplier-invoices/$id', params: { id: row.id } })}
          />
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
