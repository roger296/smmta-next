import * as React from 'react';
import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  INVOICE_STATUSES,
  useAllocatePayment,
  useCreateCreditNote,
  useInvoice,
} from '@/features/invoices/use-invoices';
import {
  AllocatePaymentDialog,
  CreditNoteDialog,
} from '@/features/invoices/invoice-action-dialogs';
import { useToast } from '@/hooks/use-toast';
import { formatDate, formatMoney } from '@/lib/format';
import { ArrowLeft, Banknote, FileMinus } from 'lucide-react';

export const Route = createFileRoute('/_authed/invoices/$id')({
  component: InvoiceDetailPage,
});

function InvoiceDetailPage() {
  const { id } = useParams({ from: '/_authed/invoices/$id' });
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useInvoice(id);
  const paymentMutation = useAllocatePayment();
  const creditNoteMutation = useCreateCreditNote();
  const [paymentOpen, setPaymentOpen] = React.useState(false);
  const [creditNoteOpen, setCreditNoteOpen] = React.useState(false);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6" role="alert">
          <p className="text-sm text-[var(--color-destructive)]">
            Failed to load: {error instanceof Error ? error.message : 'Not found'}
          </p>
          <Button variant="outline" className="mt-4" asChild>
            <Link to="/invoices">
              <ArrowLeft className="h-4 w-4" /> Back
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const statusMeta = INVOICE_STATUSES.find((s) => s.value === data.status);
  const canReceivePayment = data.status !== 'PAID' && data.status !== 'VOIDED';
  const canCreditNote = data.status !== 'DRAFT' && data.status !== 'VOIDED';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link
            to="/invoices"
            className="mb-2 inline-flex items-center text-sm text-[var(--color-muted-foreground)] hover:underline"
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            Invoices
          </Link>
          <h1 className="text-2xl font-semibold">{data.invoiceNumber}</h1>
          <div className="mt-1 flex items-center gap-2">
            <Badge
              variant={(statusMeta?.color ?? 'outline') as 'default' | 'secondary' | 'destructive' | 'outline'}
            >
              {statusMeta?.label ?? data.status}
            </Badge>
            <span className="text-sm text-[var(--color-muted-foreground)]">
              {formatDate(data.dateOfInvoice)}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {canReceivePayment && (
            <Button size="sm" onClick={() => setPaymentOpen(true)}>
              <Banknote className="h-4 w-4" />
              Record payment
            </Button>
          )}
          {canCreditNote && (
            <Button size="sm" variant="outline" onClick={() => setCreditNoteOpen(true)}>
              <FileMinus className="h-4 w-4" />
              Credit note
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Total
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatMoney(data.total)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatMoney(data.paidAmount)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Outstanding
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-[var(--color-destructive)]">
              {formatMoney(data.outstandingAmount)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
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
                  <td className="px-4 py-2">{line.productName ?? line.productId.slice(0, 8)}</td>
                  <td className="px-4 py-2 text-right">{line.quantity}</td>
                  <td className="px-4 py-2 text-right">{formatMoney(line.pricePerUnit)}</td>
                  <td className="px-4 py-2 text-right">{line.taxRate}%</td>
                  <td className="px-4 py-2 text-right font-medium">
                    {formatMoney(line.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <AllocatePaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        invoice={data}
        onConfirm={async (input) => {
          try {
            await paymentMutation.mutateAsync({ invoiceId: data.id, input });
            toast({ title: 'Payment recorded' });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Failed',
              description: err instanceof Error ? err.message : 'Unknown',
            });
            throw err;
          }
        }}
      />
      <CreditNoteDialog
        open={creditNoteOpen}
        onOpenChange={setCreditNoteOpen}
        invoice={data}
        onConfirm={async (input) => {
          try {
            await creditNoteMutation.mutateAsync({ invoiceId: data.id, input });
            toast({ title: 'Credit note issued' });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Failed',
              description: err instanceof Error ? err.message : 'Unknown',
            });
            throw err;
          }
        }}
      />
    </div>
  );
}
