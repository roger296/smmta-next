import * as React from 'react';
import { createFileRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  ORDER_STATUSES,
  useAllocateStock,
  useChangeOrderStatus,
  useCreateInvoiceFromOrder,
  useDeallocateStock,
  useDeleteOrder,
  useOrder,
} from '@/features/orders/use-orders';
import {
  AllocateStockDialog,
  CreateInvoiceDialog,
} from '@/features/orders/order-action-dialogs';
import { useToast } from '@/hooks/use-toast';
import { formatDate, formatMoney } from '@/lib/format';
import { ArrowLeft, FileText, PackageCheck, PackageX, Trash2, XCircle } from 'lucide-react';

export const Route = createFileRoute('/_authed/orders/$id')({
  component: OrderDetailPage,
});

function OrderDetailPage() {
  const { id } = useParams({ from: '/_authed/orders/$id' });
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useOrder(id);
  const statusMutation = useChangeOrderStatus();
  const allocateMutation = useAllocateStock();
  const deallocateMutation = useDeallocateStock();
  const invoiceMutation = useCreateInvoiceFromOrder();
  const deleteMutation = useDeleteOrder();

  const [allocateOpen, setAllocateOpen] = React.useState(false);
  const [invoiceOpen, setInvoiceOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6" role="alert">
          <p className="text-sm text-[var(--color-destructive)]">
            Failed to load: {error instanceof Error ? error.message : 'Not found'}
          </p>
          <Button variant="outline" className="mt-4" asChild>
            <Link to="/orders">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const statusMeta = ORDER_STATUSES.find((s) => s.value === data.status);
  const canAllocate = ['CONFIRMED', 'PARTIALLY_ALLOCATED', 'BACK_ORDERED'].includes(data.status);
  const canInvoice = ['ALLOCATED', 'SHIPPED', 'READY_TO_SHIP', 'PARTIALLY_SHIPPED'].includes(
    data.status,
  );
  const canCancel = !['CANCELLED', 'COMPLETED', 'INVOICED'].includes(data.status);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link
            to="/orders"
            className="mb-2 inline-flex items-center text-sm text-[var(--color-muted-foreground)] hover:underline"
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            Orders
          </Link>
          <h1 className="text-2xl font-semibold">{data.orderNumber}</h1>
          <div className="mt-1 flex items-center gap-2">
            <Badge
              variant={
                (statusMeta?.color ?? 'outline') as 'default' | 'secondary' | 'destructive' | 'outline'
              }
            >
              {statusMeta?.label ?? data.status}
            </Badge>
            <span className="text-sm text-[var(--color-muted-foreground)]">
              {formatDate(data.orderDate)}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {canAllocate && (
            <Button size="sm" onClick={() => setAllocateOpen(true)}>
              <PackageCheck className="h-4 w-4" />
              Allocate stock
            </Button>
          )}
          {data.status === 'ALLOCATED' && (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await deallocateMutation.mutateAsync(data.id);
                  toast({ title: 'Stock deallocated' });
                } catch (err) {
                  toast({
                    variant: 'destructive',
                    title: 'Failed',
                    description: err instanceof Error ? err.message : 'Unknown',
                  });
                }
              }}
            >
              <PackageX className="h-4 w-4" />
              Deallocate
            </Button>
          )}
          {canInvoice && (
            <Button size="sm" onClick={() => setInvoiceOpen(true)}>
              <FileText className="h-4 w-4" />
              Create invoice
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="outline" onClick={() => setConfirmCancel(true)}>
              <XCircle className="h-4 w-4" />
              Cancel
            </Button>
          )}
          {data.status === 'DRAFT' && (
            <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Subtotal
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatMoney(data.subtotal, data.currencyCode)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Tax
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatMoney(data.taxAmount, data.currencyCode)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Total
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatMoney(data.total, data.currencyCode)}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="lines">
        <TabsList>
          <TabsTrigger value="lines">Lines ({data.lines?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        <TabsContent value="lines">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Product</th>
                    <th className="px-4 py-2 text-right font-medium">Qty</th>
                    <th className="px-4 py-2 text-right font-medium">Unit price</th>
                    <th className="px-4 py-2 text-right font-medium">Tax %</th>
                    <th className="px-4 py-2 text-right font-medium">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.lines ?? []).map((line) => (
                    <tr key={line.id} className="border-b border-[var(--color-border)] last:border-b-0">
                      <td className="px-4 py-2">
                        {line.productName ?? line.productId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-2 text-right">{line.quantity}</td>
                      <td className="px-4 py-2 text-right">
                        {formatMoney(line.pricePerUnit, data.currencyCode)}
                      </td>
                      <td className="px-4 py-2 text-right">{line.taxRate}%</td>
                      <td className="px-4 py-2 text-right font-medium">
                        {formatMoney(line.lineTotal, data.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="details">
          <Card>
            <CardContent className="grid gap-4 p-6 md:grid-cols-2 text-sm">
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Customer
                </dt>
                <dd>{data.customerName ?? data.customerId}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Source
                </dt>
                <dd>{data.sourceChannel}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Customer PO
                </dt>
                <dd>{data.customerOrderNumber ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Tracking
                </dt>
                <dd>{data.trackingNumber ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Delivery date
                </dt>
                <dd>{data.deliveryDate ? formatDate(data.deliveryDate) : '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Margin
                </dt>
                <dd>{formatMoney(data.margin, data.currencyCode)}</dd>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AllocateStockDialog
        open={allocateOpen}
        onOpenChange={setAllocateOpen}
        defaultWarehouseId={data.warehouseId ?? undefined}
        onConfirm={async (warehouseId) => {
          try {
            await allocateMutation.mutateAsync({ orderId: data.id, warehouseId });
            toast({ title: 'Stock allocated' });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Allocation failed',
              description: err instanceof Error ? err.message : 'Unknown',
            });
            throw err;
          }
        }}
      />
      <CreateInvoiceDialog
        open={invoiceOpen}
        onOpenChange={setInvoiceOpen}
        onConfirm={async (input) => {
          try {
            const invoice = await invoiceMutation.mutateAsync({ orderId: data.id, input });
            toast({ title: 'Invoice created', description: invoice.invoiceNumber });
            navigate({ to: '/invoices/$id', params: { id: invoice.id } });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Invoice failed',
              description: err instanceof Error ? err.message : 'Unknown',
            });
            throw err;
          }
        }}
      />
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel order?"
        description="This will change the order status to Cancelled and release any allocated stock."
        destructive
        confirmLabel="Cancel order"
        onConfirm={async () => {
          try {
            await statusMutation.mutateAsync({ orderId: data.id, status: 'CANCELLED' });
            toast({ title: 'Order cancelled' });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Failed',
              description: err instanceof Error ? err.message : 'Unknown',
            });
          }
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete order?"
        description="Only DRAFT orders can be deleted. This cannot be undone."
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await deleteMutation.mutateAsync(data.id);
            toast({ title: 'Order deleted' });
            navigate({ to: '/orders' });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Delete failed',
              description: err instanceof Error ? err.message : 'Unknown',
            });
          }
        }}
      />
    </div>
  );
}
