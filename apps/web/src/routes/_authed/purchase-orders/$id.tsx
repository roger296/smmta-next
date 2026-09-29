import * as React from 'react';
import { createFileRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  DELIVERY_STATUSES,
  useBookAgainstOrder,
  useClosePurchaseOrder,
  useCreateSupplierInvoiceFromPO,
  usePOGRNs,
  usePurchaseOrder,
  useReceivingView,
} from '@/features/purchasing/use-purchasing';
import { useSites } from '@/features/sites/use-sites';
import { BookInDialog } from '@/features/purchasing/book-in-dialog';
import { useToast } from '@/hooks/use-toast';
import { formatDate, formatMoney } from '@/lib/format';
import { ArrowLeft, FileText, PackagePlus, XCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export const Route = createFileRoute('/_authed/purchase-orders/$id')({
  component: PODetailPage,
});

function PODetailPage() {
  const { id } = useParams({ from: '/_authed/purchase-orders/$id' });
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, isLoading, isError, error } = usePurchaseOrder(id);
  const { data: grns } = usePOGRNs(id);
  const { data: receiving } = useReceivingView(id);
  const { data: allSites } = useSites();
  const bookInMutation = useBookAgainstOrder();
  const closeMutation = useClosePurchaseOrder();
  const invoiceMutation = useCreateSupplierInvoiceFromPO();

  const [bookInOpen, setBookInOpen] = React.useState(false);
  const [invoiceOpen, setInvoiceOpen] = React.useState(false);
  const [confirmClose, setConfirmClose] = React.useState(false);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6" role="alert">
          <p className="text-sm text-[var(--color-destructive)]">
            Failed to load: {error instanceof Error ? error.message : 'Not found'}
          </p>
          <Button variant="outline" className="mt-4" asChild>
            <Link to="/purchase-orders">
              <ArrowLeft className="h-4 w-4" /> Back
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const statusMeta = DELIVERY_STATUSES.find((s) => s.value === data.deliveryStatus);
  // A complete order can still take a late extra (an over-delivery), so
  // only a CLOSED order hides booking in.
  const canBookIn = data.deliveryStatus !== 'CANCELLED' && !!receiving;
  const canInvoice = data.invoicedStatus !== 'FULLY_INVOICED' && data.deliveryStatus !== 'CANCELLED';
  const canClose = data.deliveryStatus !== 'CANCELLED' && data.deliveryStatus !== 'FULLY_RECEIVED';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link
            to="/purchase-orders"
            className="mb-2 inline-flex items-center text-sm text-[var(--color-muted-foreground)] hover:underline"
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            Purchase orders
          </Link>
          <h1 className="text-2xl font-semibold">{data.poNumber}</h1>
          <div className="mt-1 flex items-center gap-2">
            <Badge
              variant={(statusMeta?.color ?? 'outline') as 'default' | 'secondary' | 'destructive' | 'outline'}
            >
              {statusMeta?.label ?? data.deliveryStatus}
            </Badge>
            <span className="text-sm text-[var(--color-muted-foreground)]">
              {formatDate(data.createdAt)}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {canBookIn && (
            <Button size="sm" onClick={() => setBookInOpen(true)}>
              <PackagePlus className="h-4 w-4" />
              Book in
            </Button>
          )}
          {canInvoice && (
            <Button size="sm" variant="outline" onClick={() => setInvoiceOpen(true)}>
              <FileText className="h-4 w-4" />
              Create invoice
            </Button>
          )}
          {canClose && (
            <Button size="sm" variant="outline" onClick={() => setConfirmClose(true)}>
              <XCircle className="h-4 w-4" />
              Close
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
            <div className="text-xl font-bold">
              {formatMoney(data.subtotal, data.currencyCode)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Tax
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">
              {formatMoney(data.taxAmount, data.currencyCode)}
            </div>
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
          <TabsTrigger value="grns">
            Deliveries ({(receiving?.receipts.length ?? 0) + (grns?.length ?? 0)})
          </TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        <TabsContent value="lines">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Product</th>
                    <th className="px-4 py-2 text-right font-medium">Ordered</th>
                    <th className="px-4 py-2 text-right font-medium">Received</th>
                    <th className="px-4 py-2 text-right font-medium">Still to come</th>
                    <th className="px-4 py-2 text-right font-medium">Invoiced</th>
                    <th className="px-4 py-2 text-right font-medium">Unit cost</th>
                    <th className="px-4 py-2 text-right font-medium">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.lines ?? []).map((line) => (
                    <tr key={line.id} className="border-b border-[var(--color-border)] last:border-b-0">
                      <td className="px-4 py-2">
                        {line.productName ?? line.productId.slice(0, 8)}
                        {line.purchaseUom && (
                          <span className="block text-xs text-[var(--color-muted-foreground)]">in {line.purchaseUom}s</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">{line.quantity}</td>
                      <td className="px-4 py-2 text-right">{line.quantityReceived}</td>
                      <td className="px-4 py-2 text-right font-medium">
                        {Math.max(0, Math.round((Number(line.quantity) - Number(line.quantityReceived)) * 1000) / 1000)}
                      </td>
                      <td className="px-4 py-2 text-right">{line.quantityInvoiced}</td>
                      <td className="px-4 py-2 text-right">
                        {formatMoney(line.pricePerUnit, data.currencyCode)}
                      </td>
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
        <TabsContent value="grns">
          {receiving && receiving.receipts.length > 0 ? (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Booked in</th>
                      <th className="px-4 py-2 text-left font-medium">Delivery note</th>
                      <th className="px-4 py-2 text-right font-medium">Lines</th>
                      <th className="px-4 py-2 text-left font-medium">Against the order</th>
                      <th className="px-4 py-2 text-right font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receiving.receipts.map((r) => (
                      <tr key={r.id} className="border-b border-[var(--color-border)] last:border-b-0">
                        <td className="px-4 py-2">{formatDate(r.receivedAt)}</td>
                        <td className="px-4 py-2">{r.deliveryNoteNumber ?? '—'}</td>
                        <td className="px-4 py-2 text-right">{r.lines}</td>
                        <td className="px-4 py-2">
                          {r.reversalOfReceiptId ? (
                            <Badge variant="outline">Undo of an earlier booking</Badge>
                          ) : r.reversedAt ? (
                            <Badge variant="outline">Undone</Badge>
                          ) : (
                            <Badge variant={r.variance === 'OVER' ? 'destructive' : 'secondary'}>
                              {r.variance === 'OVER' ? 'More than ordered' : r.variance === 'UNDER' ? 'Part delivery' : 'Complete'}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">{formatMoney(r.totalStockValue, data.currencyCode)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">Nothing booked in against this order yet.</p>
          )}
          {grns && grns.length > 0 && (
            <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
              Also on file from the old book-in: {grns.map((g) => g.grnNumber).join(', ')}.
            </p>
          )}
        </TabsContent>
        <TabsContent value="details">
          <Card>
            <CardContent className="grid gap-4 p-6 md:grid-cols-2 text-sm">
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Supplier
                </dt>
                <dd>{data.supplierName ?? data.supplierId}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">Venue</dt>
                <dd>{data.siteName ?? 'Not set — chosen when booking in'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Invoiced status
                </dt>
                <dd>{data.invoicedStatus}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Expected delivery
                </dt>
                <dd>{data.expectedDeliveryDate ? formatDate(data.expectedDeliveryDate) : '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Tracking
                </dt>
                <dd>{data.trackingNumber ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Exchange rate
                </dt>
                <dd>{data.exchangeRate}</dd>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {receiving && (
        <BookInDialog
          open={bookInOpen}
          onOpenChange={setBookInOpen}
          view={receiving}
          sites={(allSites ?? []).filter((s) => s.isActive)}
          onConfirm={async (input) => {
            // A refusal is shown in the dialog, which stays open with what was typed.
            await bookInMutation.mutateAsync({ purchaseOrderId: data.id, ...input });
            toast({
              title: 'Booked in',
              description: `${input.lines.length} line${input.lines.length === 1 ? '' : 's'} booked into stock`,
            });
          }}
        />
      )}
      <SupplierInvoiceDialog
        open={invoiceOpen}
        onOpenChange={setInvoiceOpen}
        onConfirm={async (input) => {
          try {
            const inv = await invoiceMutation.mutateAsync({ purchaseOrderId: data.id, input });
            toast({ title: 'Supplier invoice created' });
            navigate({ to: '/supplier-invoices/$id', params: { id: inv.id } });
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
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Close this PO?"
        description="Closing says the rest is never coming: nothing more can be booked in against it, and anything still to come is dropped."
        confirmLabel="Close PO"
        onConfirm={async () => {
          try {
            await closeMutation.mutateAsync(data.id);
            toast({ title: 'PO closed' });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Failed',
              description: err instanceof Error ? err.message : 'Unknown',
            });
          }
        }}
      />
    </div>
  );
}

interface SupplierInvoiceDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (input: {
    invoiceNumber: string;
    dateOfInvoice: string;
    dueDateOfInvoice?: string;
  }) => Promise<void>;
}

function SupplierInvoiceDialog({ open, onOpenChange, onConfirm }: SupplierInvoiceDialogProps) {
  const [invoiceNumber, setInvoiceNumber] = React.useState('');
  const [dateOfInvoice, setDateOfInvoice] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create supplier invoice</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sinv-num">Supplier invoice #</Label>
            <Input
              id="sinv-num"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="e.g. INV-2026-001"
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sinv-date">Date</Label>
              <Input
                id="sinv-date"
                type="date"
                value={dateOfInvoice}
                onChange={(e) => setDateOfInvoice(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sinv-due">Due date</Label>
              <Input
                id="sinv-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || !invoiceNumber.trim()}
            onClick={async () => {
              setError(null);
              setPending(true);
              try {
                await onConfirm({
                  invoiceNumber: invoiceNumber.trim(),
                  dateOfInvoice,
                  dueDateOfInvoice: dueDate || undefined,
                });
                onOpenChange(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown');
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
