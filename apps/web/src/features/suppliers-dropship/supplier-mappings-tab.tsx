import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useDropshipSuppliers, useProductSupplierMappings, useUpsertSupplierMappings } from './use-dropship-suppliers';
import { Trash2 } from 'lucide-react';

interface RowState {
  supplierId: string;
  supplierSku: string;
  costGbp: string;
  priority: number;
  isActive: boolean;
  lastKnownStock?: number | null;
  lastKnownPrice?: string | null;
  lastPolledAt?: string | null;
}

const isPriceValid = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.trim());

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
          costGbp: m.costGbp,
          priority: m.priority,
          isActive: m.isActive,
          lastKnownStock: m.lastKnownStock,
          lastKnownPrice: m.lastKnownPrice,
          lastPolledAt: m.lastPolledAt,
        })),
      );
    }
  }, [mappings]);

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  const dropshipSuppliers = (suppliers ?? []).filter((s) => s.connectorKind !== 'NONE');

  const setRow = (idx: number, patch: Partial<RowState>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { supplierId: dropshipSuppliers[0]?.id ?? '', supplierSku: '', costGbp: '0.00', priority: 100, isActive: true },
    ]);
  };

  const removeRow = (idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    for (const r of rows) {
      if (!r.supplierId) {
        toast({ variant: 'destructive', title: 'Pick a supplier on every row' });
        return;
      }
      if (!r.supplierSku.trim()) {
        toast({ variant: 'destructive', title: 'Supplier SKU is required on every row' });
        return;
      }
      if (!isPriceValid(r.costGbp)) {
        toast({ variant: 'destructive', title: 'Cost price must be a decimal (e.g. 4.99)' });
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
            costGbp: r.costGbp.trim(),
            priority: r.priority,
            isActive: r.isActive,
          })),
        },
      });
      toast({ title: 'Supplier mappings saved' });
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
        <CardTitle>Suppliers (drop-ship)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Map this product to one or more drop-ship suppliers. The polling worker
          updates "last known stock" automatically; the cost is what you pay them.
        </p>
        {dropshipSuppliers.length === 0 && (
          <p className="text-sm text-[var(--color-destructive)]">
            No drop-ship suppliers configured yet. Set one up at <code>/suppliers</code> first.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Supplier</th>
                <th className="px-3 py-2 text-left font-medium">Their SKU</th>
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
                  <td colSpan={7} className="px-3 py-4 text-center text-[var(--color-muted-foreground)]">
                    No supplier mappings yet.
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
                      {dropshipSuppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="Supplier SKU"
                      value={r.supplierSku}
                      onChange={(e) => setRow(idx, { supplierSku: e.target.value })}
                      className="w-32"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="Cost"
                      value={r.costGbp}
                      onChange={(e) => setRow(idx, { costGbp: e.target.value })}
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
                    {r.lastKnownStock !== undefined && r.lastKnownStock !== null
                      ? `${r.lastKnownStock}${r.lastPolledAt ? ` · ${relTime(r.lastPolledAt)}` : ''}`
                      : 'never polled'}
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
          <Button variant="outline" onClick={addRow} disabled={dropshipSuppliers.length === 0}>
            Add supplier mapping
          </Button>
          <Button onClick={handleSave} disabled={upsertMutation.isPending}>
            {upsertMutation.isPending ? 'Saving…' : 'Save mappings'}
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
