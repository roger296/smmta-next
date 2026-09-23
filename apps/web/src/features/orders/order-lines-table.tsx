import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProductPicker } from '@/components/forms/entity-pickers';
import { useToast } from '@/hooks/use-toast';
import { apiFetch } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import type { Order, OrderLine } from '@/lib/api-types';

const CLOSED_STATUSES = ['SHIPPED', 'PARTIALLY_SHIPPED', 'COMPLETED', 'CANCELLED', 'INVOICED'];

/** Whether the order's lines may still be changed: open, not invoiced, not paid for online. */
export function linesEditable(order: Order): boolean {
  if (CLOSED_STATUSES.includes(order.status)) return false;
  if (order.invoices && order.invoices.length > 0) return false;
  const meta = order.integrationMetadata as { mollie?: unknown } | null | undefined;
  return !meta?.mollie;
}

function useLineMutations(orderId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const settled = () => {
    // The order, its readiness, pick note and holds all live under this key.
    qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
    qc.invalidateQueries({ queryKey: ['orders', 'list'] });
  };
  const failed = (title: string) => (err: unknown) =>
    toast({ variant: 'destructive', title, description: err instanceof Error ? err.message : 'Unknown error' });
  const change = useMutation({
    mutationFn: ({ lineId, ...body }: { lineId: string; quantity?: number; pricePerUnit?: number }) =>
      apiFetch(`/orders/${orderId}/lines/${lineId}`, { method: 'PATCH', body }),
    onError: failed('Line not changed'),
    onSettled: settled,
  });
  const add = useMutation({
    mutationFn: (body: { productId: string; quantity: number; pricePerUnit: number; taxRate: number }) =>
      apiFetch(`/orders/${orderId}/lines`, { method: 'POST', body }),
    onError: failed('Line not added'),
    onSettled: settled,
  });
  const remove = useMutation({
    mutationFn: (lineId: string) => apiFetch(`/orders/${orderId}/lines/${lineId}`, { method: 'DELETE' }),
    onError: failed('Line not removed'),
    onSettled: settled,
  });
  return { change, add, remove };
}

function LineRow({ line, currency, editable, onChange, onRemove, busy }: {
  line: OrderLine;
  currency: string;
  editable: boolean;
  busy: boolean;
  onChange: (input: { quantity?: number; pricePerUnit?: number }) => Promise<unknown>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [quantity, setQuantity] = React.useState(String(line.quantity));
  const [price, setPrice] = React.useState(String(line.pricePerUnit));

  const start = () => {
    setQuantity(String(line.quantity));
    setPrice(String(line.pricePerUnit));
    setEditing(true);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = Number(quantity);
    const p = Number(price);
    const input: { quantity?: number; pricePerUnit?: number } = {};
    if (q !== Number(line.quantity)) input.quantity = q;
    if (p !== Number(line.pricePerUnit)) input.pricePerUnit = p;
    if (Object.keys(input).length > 0) await onChange(input);
    setEditing(false);
  };

  const name = line.product?.name ?? line.productName ?? line.productId.slice(0, 8);
  if (!editing) {
    return (
      <tr className="border-b border-[var(--color-border)] last:border-b-0" data-test="order-line">
        <td className="px-4 py-2">{name}</td>
        <td className="px-4 py-2 text-right">{line.quantity}</td>
        <td className="px-4 py-2 text-right">{formatMoney(line.pricePerUnit, currency)}</td>
        <td className="px-4 py-2 text-right">{line.taxRate}%</td>
        <td className="px-4 py-2 text-right font-medium">{formatMoney(line.lineTotal, currency)}</td>
        {editable && (
          <td className="px-2 py-1 text-right whitespace-nowrap">
            <Button variant="ghost" size="icon" onClick={start} disabled={busy} aria-label={`Change ${name}`}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onRemove} disabled={busy} aria-label={`Remove ${name}`}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </td>
        )}
      </tr>
    );
  }
  const formId = `line-${line.id}`;
  return (
    <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)] last:border-b-0" data-test="order-line-editing">
      <td className="px-4 py-2">
        {name}
        <form id={formId} onSubmit={save} />
      </td>
      <td className="px-2 py-1">
        <Input
          form={formId}
          type="number"
          step="0.01"
          min={0.01}
          required
          autoFocus
          className="w-24 text-right"
          aria-label={`Quantity of ${name}`}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </td>
      <td className="px-2 py-1">
        <Input
          form={formId}
          type="number"
          step="0.01"
          min={0}
          required
          className="w-28 text-right"
          aria-label={`Unit price of ${name}`}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </td>
      <td className="px-4 py-2 text-right">{line.taxRate}%</td>
      <td className="px-4 py-2 text-right font-medium">{formatMoney(Number(quantity || 0) * Number(price || 0), currency)}</td>
      <td className="px-2 py-1 text-right whitespace-nowrap">
        <Button variant="ghost" size="icon" type="submit" form={formId} disabled={busy} aria-label="Save line">
          <Check className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" type="button" onClick={() => setEditing(false)} aria-label="Cancel">
          <X className="h-4 w-4" />
        </Button>
      </td>
    </tr>
  );
}

/**
 * The order's lines, editable while the order is open: change a quantity or
 * price in place, remove a line, add one. The server recomputes the totals,
 * releases stock the order no longer needs and refreshes the pick note.
 */
export function OrderLinesTable({ order }: { order: Order }) {
  const editable = linesEditable(order);
  const { change, add, remove } = useLineMutations(order.id);
  const busy = change.isPending || add.isPending || remove.isPending;
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState({ productId: '', quantity: '1', pricePerUnit: '0', taxRate: '20' });
  const lines = order.lines ?? [];

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.productId) return;
    try {
      await add.mutateAsync({
        productId: draft.productId,
        quantity: Number(draft.quantity),
        pricePerUnit: Number(draft.pricePerUnit),
        taxRate: Number(draft.taxRate),
      });
      setAdding(false);
      setDraft({ productId: '', quantity: '1', pricePerUnit: '0', taxRate: '20' });
    } catch {
      // The mutation has already shown why.
    }
  };

  return (
    <div>
      <table className="w-full text-sm">
        <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Product</th>
            <th className="px-4 py-2 text-right font-medium">Qty</th>
            <th className="px-4 py-2 text-right font-medium">Unit price</th>
            <th className="px-4 py-2 text-right font-medium">Tax %</th>
            <th className="px-4 py-2 text-right font-medium">Line total</th>
            {editable && <th className="w-24 px-2 py-2" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <LineRow
              key={line.id}
              line={line}
              currency={order.currencyCode}
              editable={editable}
              busy={busy}
              onChange={(input) => change.mutateAsync({ lineId: line.id, ...input })}
              onRemove={() => {
                if (lines.length <= 1) return;
                if (window.confirm(`Remove ${line.product?.name ?? 'this line'} from the order?`)) remove.mutate(line.id);
              }}
            />
          ))}
          {adding && (
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)]" data-test="order-line-adding">
              <td className="px-2 py-1">
                <form id="add-line" onSubmit={submitAdd} />
                <ProductPicker value={draft.productId || undefined} onChange={(v) => setDraft({ ...draft, productId: v ?? '' })} />
              </td>
              <td className="px-2 py-1">
                <Input form="add-line" type="number" step="0.01" min={0.01} required className="w-24 text-right" aria-label="Quantity" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
              </td>
              <td className="px-2 py-1">
                <Input form="add-line" type="number" step="0.01" min={0} required className="w-28 text-right" aria-label="Unit price" value={draft.pricePerUnit} onChange={(e) => setDraft({ ...draft, pricePerUnit: e.target.value })} />
              </td>
              <td className="px-2 py-1">
                <Input form="add-line" type="number" step="0.01" min={0} max={100} required className="w-20 text-right" aria-label="Tax rate" value={draft.taxRate} onChange={(e) => setDraft({ ...draft, taxRate: e.target.value })} />
              </td>
              <td className="px-4 py-2 text-right font-medium">
                {formatMoney(Number(draft.quantity || 0) * Number(draft.pricePerUnit || 0), order.currencyCode)}
              </td>
              <td className="px-2 py-1 text-right whitespace-nowrap">
                <Button variant="ghost" size="icon" type="submit" form="add-line" disabled={busy || !draft.productId} aria-label="Add line">
                  <Check className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" type="button" onClick={() => setAdding(false)} aria-label="Cancel">
                  <X className="h-4 w-4" />
                </Button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {editable && !adding && (
        <div className="border-t border-[var(--color-border)] p-2">
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={busy} data-test="add-line">
            <Plus className="h-4 w-4" />
            Add line
          </Button>
        </div>
      )}
    </div>
  );
}
