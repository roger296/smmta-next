import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ORDER_STATUSES, useOrdersList } from '@/features/orders/use-orders';
import {
  useBulkAllocate,
  useBulkInvoice,
  useBulkStatusChange,
  type BulkResult,
} from '@/features/integrations/use-integrations';
import { useWarehouses } from '@/features/reference/use-reference';
import { useToast } from '@/hooks/use-toast';
import type { OrderStatus } from '@/lib/api-types';
import { formatDate, formatMoney } from '@/lib/format';

export const Route = createFileRoute('/_authed/integrations/bulk')({
  component: BulkOpsPage,
});

type BulkAction = 'status' | 'allocate' | 'invoice';

function BulkOpsPage() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = React.useState<OrderStatus | ''>('');
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [action, setAction] = React.useState<BulkAction>('status');
  const [newStatus, setNewStatus] = React.useState<OrderStatus>('CONFIRMED');
  const [warehouseId, setWarehouseId] = React.useState('');
  const [result, setResult] = React.useState<BulkResult | null>(null);

  const { data, isLoading } = useOrdersList({
    status: statusFilter || undefined,
    pageSize: 100,
  });
  const { data: warehouses } = useWarehouses();

  const statusMutation = useBulkStatusChange();
  const allocateMutation = useBulkAllocate();
  const invoiceMutation = useBulkInvoice();

  const handleRun = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      return toast({
        variant: 'destructive',
        title: 'Select at least one order',
      });
    }
    try {
      let res: BulkResult;
      if (action === 'status') {
        res = await statusMutation.mutateAsync({ orderIds: ids, status: newStatus });
      } else if (action === 'allocate') {
        if (!warehouseId) {
          return toast({ variant: 'destructive', title: 'Pick a warehouse' });
        }
        res = await allocateMutation.mutateAsync({ orderIds: ids, warehouseId });
      } else {
        res = await invoiceMutation.mutateAsync({ orderIds: ids });
      }
      setResult(res);
      setSelectedIds(new Set());
      toast({
        title: 'Bulk action complete',
        description: `${res.succeeded} succeeded, ${res.failed} failed`,
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Bulk action failed',
        description: err instanceof Error ? err.message : 'Unknown',
      });
    }
  };

  const allVisibleSelected =
    data && data.data.length > 0 && data.data.every((o) => selectedIds.has(o.id));

  const pending =
    statusMutation.isPending || allocateMutation.isPending || invoiceMutation.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Bulk order operations</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Apply an action to multiple orders at once.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Select
          value={statusFilter || 'all'}
          onValueChange={(v) => {
            setStatusFilter(v === 'all' ? '' : (v as OrderStatus));
            setSelectedIds(new Set());
          }}
        >
          <SelectTrigger className="w-56" aria-label="Filter by status">
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

      <Card>
        <CardHeader>
          <CardTitle>Select orders ({selectedIds.size} selected)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading && (
            <div className="p-6">
              <Skeleton className="h-32 w-full" />
            </div>
          )}
          {!isLoading && data && (
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="w-10 px-4 py-2">
                    <Checkbox
                      aria-label="Select all visible"
                      checked={allVisibleSelected}
                      onCheckedChange={(c) => {
                        if (c === true) {
                          setSelectedIds(new Set(data.data.map((o) => o.id)));
                        } else {
                          setSelectedIds(new Set());
                        }
                      }}
                    />
                  </th>
                  <th className="px-4 py-2 text-left font-medium">Order #</th>
                  <th className="px-4 py-2 text-left font-medium">Customer</th>
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((order) => {
                  const meta = ORDER_STATUSES.find((s) => s.value === order.status);
                  return (
                    <tr key={order.id} className="border-b border-[var(--color-border)] last:border-b-0">
                      <td className="px-4 py-2">
                        <Checkbox
                          aria-label={`Select order ${order.orderNumber}`}
                          checked={selectedIds.has(order.id)}
                          onCheckedChange={(c) => {
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (c === true) next.add(order.id);
                              else next.delete(order.id);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td className="px-4 py-2">{order.orderNumber}</td>
                      <td className="px-4 py-2">
                        {order.customerName ?? order.customerId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-2">{formatDate(order.orderDate)}</td>
                      <td className="px-4 py-2">
                        <Badge
                          variant={(meta?.color ?? 'outline') as 'default' | 'secondary' | 'destructive' | 'outline'}
                        >
                          {meta?.label ?? order.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right">{formatMoney(order.total, order.currencyCode)}</td>
                    </tr>
                  );
                })}
                {data.data.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-6 text-center text-sm text-[var(--color-muted-foreground)]"
                    >
                      No orders match that filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Choose action</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bulk-action">
              Action
            </label>
            <Select value={action} onValueChange={(v) => setAction(v as BulkAction)}>
              <SelectTrigger id="bulk-action" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="status">Change status</SelectItem>
                <SelectItem value="allocate">Allocate stock</SelectItem>
                <SelectItem value="invoice">Create invoices</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {action === 'status' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="bulk-status">
                New status
              </label>
              <Select value={newStatus} onValueChange={(v) => setNewStatus(v as OrderStatus)}>
                <SelectTrigger id="bulk-status" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDER_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {action === 'allocate' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="bulk-wh">
                Warehouse
              </label>
              <Select value={warehouseId} onValueChange={setWarehouseId}>
                <SelectTrigger id="bulk-wh" className="w-56">
                  <SelectValue placeholder="Select warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses?.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button onClick={handleRun} disabled={pending || selectedIds.size === 0}>
            {pending ? 'Running…' : `Run on ${selectedIds.size} order(s)`}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Last result</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              <span className="font-medium text-green-700">{result.succeeded} succeeded</span>
              {' · '}
              <span className="font-medium text-[var(--color-destructive)]">{result.failed} failed</span>
            </p>
            {result.errors && result.errors.length > 0 && (
              <div className="mt-3">
                <p className="text-sm font-medium">Errors:</p>
                <ul className="mt-1 text-xs text-[var(--color-destructive)]">
                  {result.errors.map((e, i) => (
                    <li key={i}>
                      {e.orderId.slice(0, 8)}: {e.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
