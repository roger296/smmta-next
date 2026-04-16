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
import type { POLine, PurchaseOrder } from '@/lib/api-types';
import type { BookInLineInput } from './use-purchasing';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  po: PurchaseOrder;
  onConfirm: (input: {
    supplierDeliveryNoteNo?: string;
    dateBookedIn?: string;
    lines: BookInLineInput[];
  }) => Promise<void>;
}

interface RowState {
  productId: string;
  productName?: string;
  outstanding: number;
  qtyToBook: string; // string for empty state
  costPerUnit: string;
  serialNumbers: string;
}

function outstandingForLine(line: POLine): number {
  return Math.max(0, Number(line.quantity) - Number(line.quantityReceived));
}

/** Splits a comma-or-newline separated string into clean array of serials. */
export function parseSerialNumbers(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function BookInDialog({ open, onOpenChange, po, onConfirm }: Props) {
  const [dateBookedIn, setDateBookedIn] = React.useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [deliveryNote, setDeliveryNote] = React.useState('');
  const [rows, setRows] = React.useState<RowState[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const openLines = (po.lines ?? []).filter((l) => outstandingForLine(l) > 0);
    setRows(
      openLines.map((l) => ({
        productId: l.productId,
        productName: l.productName,
        outstanding: outstandingForLine(l),
        qtyToBook: '',
        costPerUnit: l.pricePerUnit,
        serialNumbers: '',
      })),
    );
    setDateBookedIn(new Date().toISOString().slice(0, 10));
    setDeliveryNote('');
    setError(null);
  }, [open, po.lines]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Book in goods received</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="grn-date">Date booked in</Label>
              <Input
                id="grn-date"
                type="date"
                value={dateBookedIn}
                onChange={(e) => setDateBookedIn(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grn-note">Supplier delivery note #</Label>
              <Input
                id="grn-note"
                value={deliveryNote}
                onChange={(e) => setDeliveryNote(e.target.value)}
              />
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              All lines on this PO are fully received.
            </p>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Product</th>
                      <th className="w-24 px-3 py-2 text-right font-medium">Outstanding</th>
                      <th className="w-28 px-3 py-2 text-right font-medium">Qty to book</th>
                      <th className="w-28 px-3 py-2 text-right font-medium">Cost / unit</th>
                      <th className="w-64 px-3 py-2 text-left font-medium">Serials (comma or newline)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className="border-b border-[var(--color-border)] last:border-b-0">
                        <td className="px-3 py-2">
                          {row.productName ?? row.productId.slice(0, 8)}
                        </td>
                        <td className="px-3 py-2 text-right">{row.outstanding}</td>
                        <td className="px-3 py-2">
                          <Input
                            type="number"
                            step="0.01"
                            min={0}
                            max={row.outstanding}
                            value={row.qtyToBook}
                            aria-label={`Line ${i + 1} quantity to book`}
                            className="text-right"
                            onChange={(e) =>
                              setRows((rs) =>
                                rs.map((r, j) => (j === i ? { ...r, qtyToBook: e.target.value } : r)),
                              )
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          <MoneyInput
                            currencySymbol="£"
                            value={row.costPerUnit}
                            aria-label={`Line ${i + 1} cost per unit`}
                            onChange={(e) =>
                              setRows((rs) =>
                                rs.map((r, j) => (j === i ? { ...r, costPerUnit: e.target.value } : r)),
                              )
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Textarea
                            value={row.serialNumbers}
                            rows={1}
                            aria-label={`Line ${i + 1} serial numbers`}
                            className="min-h-[40px]"
                            onChange={(e) =>
                              setRows((rs) =>
                                rs.map((r, j) =>
                                  j === i ? { ...r, serialNumbers: e.target.value } : r,
                                ),
                              )
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

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
            disabled={pending || rows.length === 0}
            onClick={async () => {
              setError(null);
              const linesToBook = rows
                .filter((r) => Number(r.qtyToBook) > 0)
                .map<BookInLineInput>((r) => {
                  const qty = Number(r.qtyToBook);
                  if (qty > r.outstanding) {
                    throw new Error(
                      `Qty ${qty} exceeds outstanding ${r.outstanding} for ${r.productName ?? r.productId}`,
                    );
                  }
                  const serials = parseSerialNumbers(r.serialNumbers);
                  return {
                    productId: r.productId,
                    quantityBookedIn: qty,
                    valuePerUnit: r.costPerUnit ? Number(r.costPerUnit) : undefined,
                    serialNumbers: serials.length > 0 ? serials : undefined,
                  };
                });
              if (linesToBook.length === 0) {
                return setError('Enter a quantity on at least one line');
              }
              setPending(true);
              try {
                await onConfirm({
                  supplierDeliveryNoteNo: deliveryNote || undefined,
                  dateBookedIn,
                  lines: linesToBook,
                });
                onOpenChange(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown error');
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Booking in…' : 'Book in'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
