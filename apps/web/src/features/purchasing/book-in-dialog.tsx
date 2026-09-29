import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import type { BookAgainstOrderInput, ReceivingLine, ReceivingView } from './use-purchasing';

/**
 * Book a delivery in against an order (DECISIONS.md F24).
 *
 * Every line is shown with what was ordered, what has arrived so far and what
 * is still to come. Book any lines, any part of a line; a line left blank
 * stays outstanding for a later delivery. More than is still to come is
 * allowed — suppliers round up to a case — but only once someone ticks that
 * the extra really arrived, because it is just as often a mis-pick.
 */

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  view: ReceivingView;
  /** Offered only when the order has no venue (raised before venues). */
  sites: Array<{ id: string; name: string }>;
  onConfirm: (input: Omit<BookAgainstOrderInput, 'purchaseOrderId'>) => Promise<void>;
}

export interface RowState {
  line: ReceivingLine;
  /** What arrived, in the purchase unit. '' = nothing on this delivery. */
  qty: string;
  unitCost: string;
}

export interface BookingPlan {
  lines: BookAgainstOrderInput['lines'];
  /** Lines booking more than is still to come. */
  over: Array<{ name: string; extra: number; unit: string }>;
  /** Lines still outstanding after this delivery. */
  leftOpen: number;
  /** Typed quantities that are not a number of zero or more. */
  invalid: string[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const unitOf = (l: ReceivingLine): string => l.product.purchaseUom ?? 'unit';

/** What a set of typed quantities would book. Pure, so it is tested alone. */
export function planBooking(rows: RowState[]): BookingPlan {
  const plan: BookingPlan = { lines: [], over: [], leftOpen: 0, invalid: [] };
  for (const r of rows) {
    const typed = r.qty.trim();
    const qty = typed === '' ? 0 : Number(typed);
    if (!Number.isFinite(qty) || qty < 0) {
      plan.invalid.push(r.line.product.name);
      continue;
    }
    if (qty > 0) {
      const cost = r.unitCost.trim() === '' ? undefined : Number(r.unitCost);
      plan.lines.push({
        purchaseOrderLineId: r.line.id,
        productId: r.line.product.id,
        qtyPurchase: round3(qty),
        ...(cost != null && Number.isFinite(cost) ? { unitCost: cost } : {}),
      });
    }
    if (qty > r.line.outstanding + 0.0005) {
      plan.over.push({ name: r.line.product.name, extra: round3(qty - r.line.outstanding), unit: unitOf(r.line) });
    }
    if (r.line.outstanding - qty > 0.0005) plan.leftOpen++;
  }
  return plan;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

export function BookInDialog({ open, onOpenChange, view, sites, onConfirm }: Props) {
  const [rows, setRows] = React.useState<RowState[]>([]);
  const [deliveryNote, setDeliveryNote] = React.useState('');
  const [siteId, setSiteId] = React.useState('');
  const [acceptOver, setAcceptOver] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setRows(view.lines.map((line) => ({ line, qty: '', unitCost: line.pricePerUnit })));
    setDeliveryNote('');
    setSiteId(view.site?.id ?? '');
    setAcceptOver(false);
    setError(null);
  }, [open, view]);

  const plan = planBooking(rows);
  const setRow = (i: number, patch: Partial<RowState>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const fillRemaining = () =>
    setRows((rs) => rs.map((r) => (r.line.outstanding > 0 ? { ...r, qty: String(r.line.outstanding) } : r)));

  const blocked =
    pending ||
    plan.lines.length === 0 ||
    plan.invalid.length > 0 ||
    !siteId ||
    (plan.over.length > 0 && !acceptOver);

  const submit = async () => {
    setError(null);
    setPending(true);
    try {
      await onConfirm({
        siteId,
        deliveryNoteNumber: deliveryNote.trim() || undefined,
        acceptOverDelivery: plan.over.length > 0 ? acceptOver : undefined,
        lines: plan.lines,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The booking was refused.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Book in against {view.poNumber} · {view.supplier.name}
          </DialogTitle>
          <DialogDescription>
            Enter what actually arrived. Leave a line blank if none of it came — it stays on the
            order for a later delivery.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bi-site">Venue</Label>
              {view.site ? (
                <p id="bi-site" className="py-2 text-sm font-medium">
                  {view.site.name}
                </p>
              ) : (
                <select
                  id="bi-site"
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className="h-9 w-full border border-[var(--color-border)] bg-[var(--color-background)] px-2 text-sm"
                >
                  <option value="">Which venue did it arrive at?</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bi-note">Supplier delivery note number</Label>
              <Input id="bi-note" value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} />
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="px-3 py-2 text-right font-medium">Ordered</th>
                    <th className="px-3 py-2 text-right font-medium">Received so far</th>
                    <th className="px-3 py-2 text-right font-medium">Still to come</th>
                    <th className="w-32 px-3 py-2 text-right font-medium">Arrived now</th>
                    <th className="w-28 px-3 py-2 text-right font-medium">Cost each (£)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const qty = Number(r.qty || 0);
                    const extra = round3(qty - r.line.outstanding);
                    return (
                      <tr
                        key={r.line.id}
                        data-testid={`book-line-${r.line.id}`}
                        className="border-b border-[var(--color-border)] last:border-b-0"
                      >
                        <td className="px-3 py-2">
                          {r.line.product.name}
                          <span className="block text-xs text-[var(--color-muted-foreground)]">
                            in {unitOf(r.line)}s
                          </span>
                          {extra > 0.0005 && (
                            <span className="block text-xs font-medium text-[var(--color-destructive)]">
                              {r.line.outstanding === 0
                                ? `Nothing is still to come — all ${plural(extra, unitOf(r.line))} would be extra`
                                : `${plural(extra, unitOf(r.line))} more than is still to come`}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">{r.line.ordered}</td>
                        <td className="px-3 py-2 text-right">{r.line.received}</td>
                        <td className="px-3 py-2 text-right font-medium">{r.line.outstanding}</td>
                        <td className="px-3 py-2">
                          <Input
                            type="number"
                            inputMode="decimal"
                            step="any"
                            min={0}
                            value={r.qty}
                            placeholder="0"
                            aria-label={`${r.line.product.name} arrived now`}
                            className="text-right"
                            onChange={(e) => setRow(i, { qty: e.target.value })}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            inputMode="decimal"
                            value={r.unitCost}
                            aria-label={`${r.line.product.name} cost each`}
                            className="text-right"
                            onChange={(e) => setRow(i, { unitCost: e.target.value })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <Button type="button" variant="outline" size="sm" onClick={fillRemaining}>
              Fill in everything still to come
            </Button>
            <span className="text-[var(--color-muted-foreground)]" role="status">
              {plan.lines.length === 0
                ? 'Nothing entered yet.'
                : `${plural(plan.lines.length, 'line')} to book` +
                  (plan.leftOpen > 0 ? ` · ${plural(plan.leftOpen, 'line')} will stay open for a later delivery` : '')}
            </span>
          </div>

          {plan.over.length > 0 && (
            <label className="flex items-start gap-2 border border-[var(--color-destructive)] p-3 text-sm">
              <input
                type="checkbox"
                checked={acceptOver}
                onChange={(e) => setAcceptOver(e.target.checked)}
                aria-label="Book in the extra"
              />
              <span>
                <strong>More than was ordered:</strong>{' '}
                {plan.over.map((o) => `${o.name} (+${plural(o.extra, o.unit)})`).join(', ')}. Tick to confirm
                it really arrived and should be booked in. If it was sent by mistake, enter what you are
                keeping and return the rest.
              </span>
            </label>
          )}

          {plan.invalid.length > 0 && (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              Check the quantity for {plan.invalid.join(', ')} — it must be a number, zero or more.
            </p>
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
          <Button disabled={blocked} onClick={() => void submit()}>
            {pending ? 'Booking in…' : 'Book in'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
