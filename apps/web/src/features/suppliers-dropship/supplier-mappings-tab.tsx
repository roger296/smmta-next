import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  useDropshipSuppliers,
  useProductSupplierMappings,
  useUpsertSupplierMappings,
} from './use-dropship-suppliers';
import { Trash2 } from 'lucide-react';

/**
 * Which suppliers carry this product, and under what code.
 *
 * Three things changed in Sept 2026, when this stopped being a drop-ship-only
 * screen and became the purchasing record:
 *
 * 1. **Every supplier is offered, not just API ones.** It used to filter to
 *    `connectorKind !== 'NONE'`, which for Big Bakes is all 72 of them — the
 *    picker was empty, the Add button was disabled, and the screen told you to
 *    go and configure drop-ship. Food suppliers order by emailed PO.
 * 2. **Cost is optional.** You learn a supplier's code long before their price,
 *    and the old default of "0.00" is not "unknown" — it is a £0.00 purchase
 *    order line.
 * 3. **Pack size and the supplier's own unit are editable.** The reorder engine
 *    already reads `supplierPackSize` to round an order up to whole packs; with
 *    no way to set it, it silently fell back to the product's own pack.
 *
 * A row's identity is (supplier, THEIR SKU) — one supplier routinely lists the
 * same item under several codes and pack sizes, and comparing those is the
 * point.
 */

interface RowState {
  supplierId: string;
  supplierSku: string;
  /** '' means "not known" — distinct from '0.00', which is a real price. */
  costGbp: string;
  priority: number;
  isActive: boolean;
  supplierPurchaseUom: string;
  supplierPackSize: string;
  lastKnownStock?: number | null;
  lastPolledAt?: string | null;
}

const isPriceValid = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.trim());
const rowKey = (r: RowState) => `${r.supplierId}::${r.supplierSku.trim().toLowerCase()}`;

export function SupplierMappingsTab({ productId }: { productId: string }) {
  const { toast } = useToast();
  const { data: suppliers } = useDropshipSuppliers();
  const { data: mappings, isLoading } = useProductSupplierMappings(productId);
  const upsertMutation = useUpsertSupplierMappings();
  const [rows, setRows] = React.useState<RowState[]>([]);

  React.useEffect(() => {
    if (mappings) {
      setRows(
        mappings.map((m) => ({
          supplierId: m.supplierId,
          supplierSku: m.supplierSku,
          costGbp: m.costGbp ?? '',
          priority: m.priority,
          isActive: m.isActive,
          supplierPurchaseUom: m.supplierPurchaseUom ?? '',
          supplierPackSize: m.supplierPackSize ?? '',
          lastKnownStock: m.lastKnownStock,
          lastPolledAt: m.lastPolledAt,
        })),
      );
    }
  }, [mappings]);

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  // Every supplier, ordered by name. A food supplier has no connector and is
  // exactly the case this screen exists for.
  const allSuppliers = [...(suppliers ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  const setRow = (idx: number, patch: Partial<RowState>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        supplierId: '',
        supplierSku: '',
        costGbp: '',
        // Lower is preferred; leave later rows behind the first by default.
        priority: prev.length === 0 ? 1 : 100,
        isActive: true,
        supplierPurchaseUom: '',
        supplierPackSize: '',
      },
    ]);
  };

  const removeRow = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx));

  const handleSave = async () => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.supplierId) {
        toast({ variant: 'destructive', title: 'Pick a supplier on every row' });
        return;
      }
      if (!r.supplierSku.trim()) {
        toast({ variant: 'destructive', title: "Every row needs the supplier's own code" });
        return;
      }
      // Caught here rather than as a 400, so the operator sees which row.
      if (seen.has(rowKey(r))) {
        toast({
          variant: 'destructive',
          title: `"${r.supplierSku.trim()}" is listed twice for the same supplier`,
          description: 'Each of a supplier’s codes can only appear once on a product.',
        });
        return;
      }
      seen.add(rowKey(r));
      if (r.costGbp.trim() !== '' && !isPriceValid(r.costGbp)) {
        toast({
          variant: 'destructive',
          title: 'Cost must be a decimal (e.g. 4.99), or left blank if you do not know it',
        });
        return;
      }
      if (r.supplierPackSize.trim() !== '' && !(Number(r.supplierPackSize) > 0)) {
        toast({ variant: 'destructive', title: 'Pack size must be a positive number' });
        return;
      }
    }
    try {
      await upsertMutation.mutateAsync({
        productId,
        input: {
          mappings: rows.map((r) => ({
            supplierId: r.supplierId,
            supplierSku: r.supplierSku.trim(),
            // Blank stays blank: null is "not known", 0 would be a real price.
            costGbp: r.costGbp.trim() === '' ? null : r.costGbp.trim(),
            priority: r.priority,
            isActive: r.isActive,
            supplierPurchaseUom:
              r.supplierPurchaseUom.trim() === '' ? null : r.supplierPurchaseUom.trim(),
            supplierPackSize:
              r.supplierPackSize.trim() === '' ? null : Number(r.supplierPackSize),
          })),
        },
      });
      toast({ title: 'Suppliers saved' });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'unknown error',
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Suppliers</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Who sells you this item and what they call it. A supplier can appear more than once —
          the same item often has several codes and pack sizes, and reordering compares them.
          The lowest <strong>priority</strong> number is the one reordering picks first. Leave the
          cost blank if you don&rsquo;t know it yet.
        </p>
        {allSuppliers.length === 0 && (
          <p className="text-sm text-[var(--color-destructive)]">
            No suppliers yet — add one on the Suppliers page first.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Supplier</th>
                <th className="px-3 py-2 text-left font-medium">Their code</th>
                <th className="px-3 py-2 text-left font-medium">Their unit</th>
                <th className="px-3 py-2 text-right font-medium">Pack size</th>
                <th className="px-3 py-2 text-left font-medium">Cost (£)</th>
                <th className="px-3 py-2 text-right font-medium">Priority</th>
                <th className="px-3 py-2 text-right font-medium">Last stock</th>
                <th className="px-3 py-2 text-center font-medium">Active</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-4 text-center text-[var(--color-muted-foreground)]"
                  >
                    No suppliers linked to this product yet.
                  </td>
                </tr>
              )}
              {rows.map((r, idx) => (
                <tr key={idx} className="border-b border-[var(--color-border)] last:border-b-0">
                  <td className="px-3 py-2">
                    <select
                      aria-label="Supplier"
                      value={r.supplierId}
                      onChange={(e) => setRow(idx, { supplierId: e.target.value })}
                      className="border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1 text-sm"
                    >
                      <option value="">— pick —</option>
                      {allSuppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="Supplier code"
                      value={r.supplierSku}
                      onChange={(e) => setRow(idx, { supplierSku: e.target.value })}
                      placeholder="20954"
                      className="w-32"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="Supplier unit"
                      value={r.supplierPurchaseUom}
                      onChange={(e) => setRow(idx, { supplierPurchaseUom: e.target.value })}
                      placeholder="sack"
                      className="w-24"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Input
                      aria-label="Pack size"
                      value={r.supplierPackSize}
                      onChange={(e) => setRow(idx, { supplierPackSize: e.target.value })}
                      placeholder="25"
                      className="w-20"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="Cost"
                      value={r.costGbp}
                      onChange={(e) => setRow(idx, { costGbp: e.target.value })}
                      placeholder="not known"
                      className="w-24"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Input
                      aria-label="Priority"
                      type="number"
                      min={0}
                      value={r.priority}
                      onChange={(e) => setRow(idx, { priority: Number(e.target.value) })}
                      className="w-20"
                    />
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-[var(--color-muted-foreground)]">
                    {/* Only an API supplier is ever polled; for an emailed-PO
                        supplier this is permanently blank, and a dash says that
                        more honestly than "never polled". */}
                    {r.lastKnownStock !== undefined && r.lastKnownStock !== null
                      ? `${r.lastKnownStock}${r.lastPolledAt ? ` · ${relTime(r.lastPolledAt)}` : ''}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Active"
                      checked={r.isActive}
                      onChange={(e) => setRow(idx, { isActive: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove row"
                      onClick={() => removeRow(idx)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between">
          <Button variant="outline" onClick={addRow} disabled={allSuppliers.length === 0}>
            Add a supplier
          </Button>
          <Button onClick={() => void handleSave()} disabled={upsertMutation.isPending}>
            {upsertMutation.isPending ? 'Saving…' : 'Save suppliers'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
