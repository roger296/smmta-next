import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
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
import { INVOICE_STATUSES, useInvoicesList } from '@/features/invoices/use-invoices';
import type { Invoice, InvoiceStatus } from '@/lib/api-types';
import { formatDate, formatMoney } from '@/lib/format';
import { FileText } from 'lucide-react';

export const Route = createFileRoute('/_authed/invoices/')({
  component: InvoicesListPage,
});

const columns: ColumnDef<Invoice>[] = [
  { accessorKey: 'invoiceNumber', header: 'Invoice #' },
  {
    accessorKey: 'customerName',
    header: 'Customer',
    cell: ({ row }) => row.original.customerName ?? row.original.customerId.slice(0, 8),
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

function InvoicesListPage() {
  const navigate = useNavigate();
  const [status, setStatus] = React.useState<InvoiceStatus | ''>('');
  const [page, setPage] = React.useState(1);
  const pageSize = 25;

  const { data, isLoading } = useInvoicesList({
    page,
    pageSize,
    status: status || undefined,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Customer invoices, credit notes and payments.
        </p>
      </div>
      <Select
        value={status || 'all'}
        onValueChange={(v) => {
          setStatus(v === 'all' ? '' : (v as InvoiceStatus));
          setPage(1);
        }}
      >
        <SelectTrigger className="w-48" aria-label="Filter by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {INVOICE_STATUSES.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isLoading && <Skeleton className="h-64 w-full" />}
      {!isLoading && data && data.data.length === 0 && (
        <EmptyState icon={FileText} title="No invoices yet" description="Invoices are created from orders." />
      )}
      {!isLoading && data && data.data.length > 0 && (
        <div className="space-y-4">
          <DataTable
            columns={columns}
            data={data.data}
            onRowClick={(row) => navigate({ to: '/invoices/$id', params: { id: row.id } })}
          />
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
