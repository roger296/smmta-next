import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { FileText, Receipt } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { formatDate, formatMoney } from '@/lib/format';
import type { Invoice } from '@/lib/api-types';
import { openInvoicePdf } from './use-ship-order';

/** The order's invoice: number, total, and its stored PDF. */
export function InvoiceCard({ invoice, currencyCode }: { invoice: Invoice; currencyCode: string }) {
  const { toast } = useToast();
  const [opening, setOpening] = React.useState(false);

  const onView = async () => {
    setOpening(true);
    try {
      await openInvoicePdf(invoice.id);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not open the invoice',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setOpening(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4" />
          Invoice
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-1">
          <p>
            <span className="font-medium">{invoice.invoiceNumber}</span> · {formatDate(invoice.dateOfInvoice)}
          </p>
          <p className="text-[var(--color-muted-foreground)]">Total {formatMoney(invoice.grandTotal, currencyCode)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onView} disabled={opening}>
            <FileText className="h-4 w-4" />
            {opening ? 'Opening…' : 'View invoice PDF'}
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/invoices/$id" params={{ id: invoice.id }}>
              Open invoice
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
