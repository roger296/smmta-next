import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  useSupplierOrders,
  useRetrySupplierOrder,
  useCancelSupplierOrder,
  useMarkSupplierOrderShipped,
  type SupplierOrderStatus,
} from '@/features/suppliers-dropship/use-supplier-orders';

export const Route = createFileRoute('/_authed/supplier-orders/')({
  component: SupplierOrdersPage,
});

const STATUSES: Array<{ value: SupplierOrderStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'PLACED', label: 'Placed' },
  { value: 'SHIPPED', label: 'Shipped' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'FAILED', label: 'Failed' },
];

function SupplierOrdersPage() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = React.useState<'ALL' | SupplierOrderStatus>('ALL');
  const { data, isLoading } = useSupplierOrders(
    statusFilter === 'ALL' ? {} : { status: statusFilter },
  );
  const retry = useRetrySupplierOrder();
  const cancel = useCancelSupplierOrder();
  const markShipped = useMarkSupplierOrderShipped();

  const handle = async (
    id: string,
    op: 'retry' | 'cancel' | 'ship',
  ) => {
    try {
      if (op === 'retry') await retry.mutateAsync({ id });
      if (op === 'cancel') await cancel.mutateAsync({ id });
      if (op === 'ship') await markShipped.mutateAsync({ id });
      toast({ title: `${op} ok` });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: `${op} failed`,
        description: err instanceof Error ? err.message : 'unknown',
      });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Supplier orders</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Track every drop-ship order placed with a supplier. Retry failures, cancel pending, mark
          shipped when a supplier emails you out-of-band.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => setStatusFilter(s.value)}
            aria-pressed={statusFilter === s.value}
            className={
              statusFilter === s.value
                ? 'border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-primary-foreground)]'
                : 'border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-xs font-medium uppercase tracking-wider hover:border-[var(--color-foreground)]'
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{data ? `${data.length} order${data.length === 1 ? '' : 's'}` : '—'}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading && <Skeleton className="h-64 w-full" />}
          {data && data.length === 0 && (
            <p className="p-6 text-sm text-[var(--color-muted-foreground)]">
              No supplier orders match the current filter.
            </p>
          )}
          {data && data.length > 0 && (
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Created</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Supplier ref</th>
                  <th className="px-3 py-2 text-right font-medium">Retries</th>
                  <th className="px-3 py-2 text-left font-medium">Tracking</th>
                  <th className="px-3 py-2 text-left font-medium">Error</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-3 py-2">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={row.status} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {row.supplierOrderRef ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">{row.retryCount}</td>
                    <td className="px-3 py-2 text-xs">
                      {row.trackingCarrier ? `${row.trackingCarrier} · ${row.trackingNumber ?? ''}` : '—'}
                    </td>
                    <td className="px-3 py-2 max-w-[260px] truncate text-xs text-[var(--color-destructive)]">
                      {row.errorMessage ?? ''}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {row.status === 'FAILED' && (
                          <Button size="sm" variant="outline" onClick={() => handle(row.id, 'retry')}>
                            Retry
                          </Button>
                        )}
                        {row.status === 'PENDING' && (
                          <Button size="sm" variant="outline" onClick={() => handle(row.id, 'cancel')}>
                            Cancel
                          </Button>
                        )}
                        {(row.status === 'PLACED' || row.status === 'ACKNOWLEDGED') && (
                          <Button size="sm" variant="outline" onClick={() => handle(row.id, 'ship')}>
                            Mark shipped
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusPill({ status }: { status: SupplierOrderStatus }) {
  const colour = (() => {
    switch (status) {
      case 'PENDING': return 'border-[var(--color-warning,#996f00)] text-[var(--color-warning,#996f00)]';
      case 'PLACED':
      case 'ACKNOWLEDGED': return 'border-[var(--color-primary)] text-[var(--color-primary)]';
      case 'SHIPPED':
      case 'DELIVERED': return 'border-[var(--color-success,#1F5C3D)] text-[var(--color-success,#1F5C3D)]';
      case 'CANCELLED': return 'border-[var(--color-muted-foreground)] text-[var(--color-muted-foreground)]';
      case 'FAILED': return 'border-[var(--color-destructive)] text-[var(--color-destructive)]';
    }
  })();
  return (
    <span className={`border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${colour}`}>
      {status}
    </span>
  );
}
