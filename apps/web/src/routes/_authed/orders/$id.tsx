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
import { ArrowLeft, FileText, PackageCheck, PackageX, Printer, Send, Trash2, XCircle } from 'lucide-react';
import { orderTotalLabels } from '@/features/orders/order-totals';
import { ShippingLabelCard } from '@/features/orders/shipping-label-card';
import { PickNoteCard } from '@/features/orders/pick-note-card';
import { InvoiceCard } from '@/features/orders/invoice-card';
import { printDispatchDocuments, useShipOrder, useShipReadiness } from '@/features/orders/use-ship-order';

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
  const shipMutation = useShipOrder();
  const { data: readiness } = useShipReadiness(id);

  const [allocateOpen, setAllocateOpen] = React.useState(false);
  const [invoiceOpen, setInvoiceOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [confirmShip, setConfirmShip] = React.useState(false);
  const [printing, setPrinting] = React.useState(false);

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
  // One invoice per order: shipping creates it, so the button goes once one exists.
  const invoice = data.invoices?.[0];
  const canInvoice =
    !invoice && ['ALLOCATED', 'SHIPPED', 'READY_TO_SHIP', 'PARTIALLY_SHIPPED'].includes(data.status);
  const canCancel = !['CANCELLED', 'COMPLETED', 'INVOICED'].includes(data.status);
  const isShipped = ['SHIPPED', 'PARTIALLY_SHIPPED', 'COMPLETED'].includes(data.status);

  const onPrintDispatch = async () => {
    setPrinting(true);
    try {
      await printDispatchDocuments(data.id);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not open the documents to print',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setPrinting(false);
    }
  };

  // Titles follow how this order's figures were stored: storefront orders
  // include tax in goods and delivery, admin-created orders add it on top.
  const totalLabels = orderTotalLabels(data);

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
          {isShipped ? (
            <Button size="sm" variant="outline" onClick={onPrintDispatch} disabled={printing}>
              <Printer className="h-4 w-4" />
              {printing ? 'Opening…' : 'Print dispatch documents'}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => setConfirmShip(true)}
              disabled={!readiness?.ready || shipMutation.isPending}
              title={readiness && !readiness.ready ? readiness.reasons.join('\n') : undefined}
              data-test="ship-order"
            >
              <Send className="h-4 w-4" />
              Ship order
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

      {!isShipped && readiness && !readiness.ready && readiness.reasons.length > 0 && (
        <div className="text-sm text-[var(--color-muted-foreground)]" data-test="ship-blockers">
          <p className="font-medium">Ship order is unavailable until:</p>
          <ul className="list-disc pl-5">
            {readiness.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              {totalLabels.goods}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatMoney(data.orderTotal, data.currencyCode)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              {totalLabels.delivery}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatMoney(data.deliveryCharge, data.currencyCode)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Tax
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatMoney(data.taxTotal, data.currencyCode)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Total
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatMoney(data.grandTotal, data.currencyCode)}</div>
          </CardContent>
        </Card>
      </div>

      <div className={invoice ? 'grid gap-4 lg:grid-cols-3' : 'grid gap-4 lg:grid-cols-2'}>
        <PickNoteCard orderId={data.id} />
        <ShippingLabelCard orderId={data.id} />
        {invoice && <InvoiceCard invoice={invoice} currencyCode={data.currencyCode} />}
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
                        {line.product?.name ?? line.productName ?? line.productId.slice(0, 8)}
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
        open={confirmShip}
        onOpenChange={setConfirmShip}
        title="Ship this order?"
        description="This marks the allocated stock as shipped, sets the order to Shipped, creates the invoice and emails the customer their courier and tracking number. The pick note and label then open, ready to print."
        confirmLabel="Ship order"
        onConfirm={async () => {
          try {
            const result = await shipMutation.mutateAsync(data.id);
            toast({
              title: 'Order shipped',
              description: result.invoiceNumber ? `Invoice ${result.invoiceNumber} created` : undefined,
            });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Could not ship the order',
              description: err instanceof Error ? err.message : 'Unknown error',
            });
            throw err;
          }
          await onPrintDispatch();
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
