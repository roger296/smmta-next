import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { MoneyInput } from '@/components/forms/money-input';
import type { Invoice } from '@/lib/api-types';
import { formatMoney } from '@/lib/format';

interface AllocatePaymentDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoice: Invoice;
  onConfirm: (input: { amount: number; paymentDate: string; reference?: string }) => Promise<void>;
}

export function AllocatePaymentDialog({
  open,
  onOpenChange,
  invoice,
  onConfirm,
}: AllocatePaymentDialogProps) {
  const outstanding = Number(invoice.outstandingAmount);
  const [amount, setAmount] = React.useState<number>(outstanding);
  const [paymentDate, setPaymentDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setAmount(outstanding);
      setPaymentDate(new Date().toISOString().slice(0, 10));
      setReference('');
      setError(null);
    }
  }, [open, outstanding]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Outstanding: <span className="font-medium">{formatMoney(outstanding)}</span>
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="pay-amount">Amount</Label>
            <MoneyInput
              id="pay-amount"
              currencySymbol="£"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-date">Payment date</Label>
            <Input
              id="pay-date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-ref">Reference</Label>
            <Input
              id="pay-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. bank transfer id"
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
            disabled={pending || amount <= 0}
            onClick={async () => {
              setError(null);
              if (amount <= 0) return setError('Amount must be > 0');
              if (amount > outstanding) return setError('Cannot exceed outstanding amount');
              setPending(true);
              try {
                await onConfirm({ amount, paymentDate, reference: reference || undefined });
                onOpenChange(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown error');
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

interface CreditNoteLine {
  productId: string;
  productName?: string;
  quantity: number;
  originalQty: number;
  pricePerUnit: number;
  taxRate: number;
  selected: boolean;
}

interface CreditNoteDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoice: Invoice;
  onConfirm: (input: {
    dateOfCreditNote: string;
    lines: {
      productId: string;
      quantity: number;
      pricePerUnit: number;
      taxRate?: number;
      description?: string;
    }[];
  }) => Promise<void>;
}

export function CreditNoteDialog({ open, onOpenChange, invoice, onConfirm }: CreditNoteDialogProps) {
  const [dateOfCreditNote, setDateOfCreditNote] = React.useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [lines, setLines] = React.useState<CreditNoteLine[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setLines(
        (invoice.lines ?? []).map((l) => ({
          productId: l.productId,
          productName: l.productName,
          quantity: 0,
          originalQty: Number(l.quantity),
          pricePerUnit: Number(l.pricePerUnit),
          taxRate: Number(l.taxRate),
          selected: false,
        })),
      );
      setDateOfCreditNote(new Date().toISOString().slice(0, 10));
      setError(null);
    }
  }, [open, invoice.lines]);

  const total = lines
    .filter((l) => l.selected)
    .reduce((sum, l) => sum + l.quantity * l.pricePerUnit * (1 + l.taxRate / 100), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Issue credit note</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cn-date">Credit note date</Label>
            <Input
              id="cn-date"
              type="date"
              value={dateOfCreditNote}
              onChange={(e) => setDateOfCreditNote(e.target.value)}
            />
          </div>
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                  <tr>
                    <th className="w-8 px-3 py-2" />
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="w-24 px-3 py-2 text-right font-medium">Original</th>
                    <th className="w-24 px-3 py-2 text-right font-medium">Credit qty</th>
                    <th className="w-28 px-3 py-2 text-right font-medium">Unit price</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-b border-[var(--color-border)] last:border-b-0">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={l.selected}
                          aria-label={`Select line ${i + 1}`}
                          onChange={(e) =>
                            setLines((ls) =>
                              ls.map((x, j) =>
                                j === i
                                  ? {
                                      ...x,
                                      selected: e.target.checked,
                                      quantity: e.target.checked ? x.originalQty : 0,
                                    }
                                  : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-2">{l.productName ?? l.productId.slice(0, 8)}</td>
                      <td className="px-3 py-2 text-right">{l.originalQty}</td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          step="0.01"
                          min={0}
                          max={l.originalQty}
                          disabled={!l.selected}
                          value={l.quantity}
                          aria-label={`Line ${i + 1} credit quantity`}
                          onChange={(e) =>
                            setLines((ls) =>
                              ls.map((x, j) =>
                                j === i ? { ...x, quantity: Number(e.target.value) } : x,
                              ),
                            )
                          }
                          className="text-right"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">{formatMoney(l.pricePerUnit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-right text-sm">
            Credit total: <span className="font-semibold">{formatMoney(total)}</span>
          </p>
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
            disabled={pending || !lines.some((l) => l.selected && l.quantity > 0)}
            onClick={async () => {
              setError(null);
              const selected = lines.filter((l) => l.selected && l.quantity > 0);
              if (selected.length === 0) {
                return setError('Select at least one line with a quantity');
              }
              for (const l of selected) {
                if (l.quantity > l.originalQty) {
                  return setError('Credit quantity cannot exceed original quantity');
                }
              }
              setPending(true);
              try {
                await onConfirm({
                  dateOfCreditNote,
                  lines: selected.map((l) => ({
                    productId: l.productId,
                    quantity: l.quantity,
                    pricePerUnit: l.pricePerUnit,
                    taxRate: l.taxRate,
                  })),
                });
                onOpenChange(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown');
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Issuing…' : 'Issue credit note'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
