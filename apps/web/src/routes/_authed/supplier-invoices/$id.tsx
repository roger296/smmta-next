import * as React from 'react';
import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyInput } from '@/components/forms/money-input';
import {
  useAllocateSupplierPayment,
  useCreateSupplierCreditNote,
  useSupplierInvoice,
} from '@/features/purchasing/use-purchasing';
import { INVOICE_STATUSES } from '@/features/invoices/use-invoices';
import { useToast } from '@/hooks/use-toast';
import { formatDate, formatMoney } from '@/lib/format';
import { ArrowLeft, Banknote, FileMinus } from 'lucide-react';

export const Route = createFileRoute('/_authed/supplier-invoices/$id')({
  component: SupplierInvoiceDetailPage,
});

function SupplierInvoiceDetailPage() {
  const { id } = useParams({ from: '/_authed/supplier-invoices/$id' });
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useSupplierInvoice(id);
  const paymentMutation = useAllocateSupplierPayment();
  const creditNoteMutation = useCreateSupplierCreditNote();
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
            <Link to="/supplier-invoices">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const statusMeta = INVOICE_STATUSES.find((s) => s.value === data.status);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link
            to="/supplier-invoices"
            className="mb-2 inline-flex items-center text-sm text-[var(--color-muted-foreground)] hover:underline"
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            Supplier invoices
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
          {data.status !== 'PAID' && data.status !== 'VOIDED' && (
            <Button size="sm" onClick={() => setPaymentOpen(true)}>
              <Banknote className="h-4 w-4" />
              Record payment
            </Button>
          )}
          {data.status !== 'DRAFT' && data.status !== 'VOIDED' && (
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

      <PaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        outstanding={Number(data.outstandingAmount)}
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
        onConfirm={async (input) => {
          try {
            await creditNoteMutation.mutateAsync({ invoiceId: data.id, input });
            toast({ title: 'Credit note recorded' });
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

interface PaymentDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  outstanding: number;
  onConfirm: (input: { amount: number; paymentDate: string; reference?: string }) => Promise<void>;
}

function PaymentDialog({ open, onOpenChange, outstanding, onConfirm }: PaymentDialogProps) {
  const [amount, setAmount] = React.useState(outstanding);
  const [paymentDate, setPaymentDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setAmount(outstanding);
      setReference('');
      setError(null);
    }
  }, [open, outstanding]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment to supplier</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Outstanding: <span className="font-medium">{formatMoney(outstanding)}</span>
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="spay-amount">Amount</Label>
            <MoneyInput
              id="spay-amount"
              currencySymbol="£"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="spay-date">Payment date</Label>
            <Input
              id="spay-date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="spay-ref">Reference</Label>
            <Input id="spay-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
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
            disabled={pending || amount <= 0}
            onClick={async () => {
              setError(null);
              if (amount <= 0) return setError('Amount must be > 0');
              if (amount > outstanding) return setError('Cannot exceed outstanding');
              setPending(true);
              try {
                await onConfirm({ amount, paymentDate, reference: reference || undefined });
                onOpenChange(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown');
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Recording…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CreditNoteDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (input: {
    creditNoteNumber: string;
    dateOfCreditNote: string;
    creditNoteTotal: number;
  }) => Promise<void>;
}

function CreditNoteDialog({ open, onOpenChange, onConfirm }: CreditNoteDialogProps) {
  const [creditNoteNumber, setCreditNoteNumber] = React.useState('');
  const [dateOfCreditNote, setDateOfCreditNote] = React.useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [total, setTotal] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setCreditNoteNumber('');
      setTotal(0);
      setError(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record credit note from supplier</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="scn-num">Credit note #</Label>
            <Input
              id="scn-num"
              value={creditNoteNumber}
              onChange={(e) => setCreditNoteNumber(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scn-date">Date</Label>
            <Input
              id="scn-date"
              type="date"
              value={dateOfCreditNote}
              onChange={(e) => setDateOfCreditNote(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scn-total">Total</Label>
            <MoneyInput
              id="scn-total"
              currencySymbol="£"
              value={total}
              onChange={(e) => setTotal(Number(e.target.value))}
            />
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
            disabled={pending || !creditNoteNumber.trim() || total <= 0}
            onClick={async () => {
              setError(null);
              setPending(true);
              try {
                await onConfirm({
                  creditNoteNumber: creditNoteNumber.trim(),
                  dateOfCreditNote,
                  creditNoteTotal: total,
                });
                onOpenChange(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown');
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Recording…' : 'Record'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
