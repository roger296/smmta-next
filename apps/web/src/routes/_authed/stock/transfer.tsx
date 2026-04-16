import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { useWarehouses } from '@/features/reference/use-reference';
import { useStockItemsList, useTransferStock } from '@/features/stock/use-stock';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/stock/transfer')({
  component: StockTransferPage,
});

function StockTransferPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: warehouses } = useWarehouses();
  const [fromWarehouseId, setFromWarehouseId] = React.useState('');
  const [toWarehouseId, setToWarehouseId] = React.useState('');
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);
  const transferMutation = useTransferStock();

  const { data: stockPage } = useStockItemsList({
    warehouseId: fromWarehouseId || undefined,
    status: 'IN_STOCK',
    pageSize: 200,
  });

  const handleSubmit = async () => {
    setError(null);
    if (!fromWarehouseId || !toWarehouseId) return setError('Pick both warehouses');
    if (fromWarehouseId === toWarehouseId) return setError('Source and target must differ');
    if (selectedIds.size === 0) return setError('Select at least one stock item');
    try {
      await transferMutation.mutateAsync({
        stockItemIds: Array.from(selectedIds),
        fromWarehouseId,
        toWarehouseId,
      });
      toast({ title: `${selectedIds.size} item(s) transferred` });
      navigate({ to: '/stock' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Transfer stock</h1>
      <Card>
        <CardHeader>
          <CardTitle>Source and destination</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="from-wh">From warehouse</Label>
            <Select value={fromWarehouseId} onValueChange={setFromWarehouseId}>
              <SelectTrigger id="from-wh">
                <SelectValue placeholder="Select source" />
              </SelectTrigger>
              <SelectContent>
                {warehouses?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to-wh">To warehouse</Label>
            <Select value={toWarehouseId} onValueChange={setToWarehouseId}>
              <SelectTrigger id="to-wh">
                <SelectValue placeholder="Select destination" />
              </SelectTrigger>
              <SelectContent>
                {warehouses?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {fromWarehouseId && (
        <Card>
          <CardHeader>
            <CardTitle>Select items to transfer</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="w-10 px-4 py-2" />
                  <th className="px-4 py-2 text-left font-medium">Product</th>
                  <th className="px-4 py-2 text-left font-medium">Serial</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {(stockPage?.data ?? []).map((item) => (
                  <tr key={item.id} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-4 py-2">
                      <Checkbox
                        checked={selectedIds.has(item.id)}
                        onCheckedChange={(c) => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (c === true) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          });
                        }}
                        aria-label={`Select ${item.productName ?? item.productId}`}
                      />
                    </td>
                    <td className="px-4 py-2">{item.productName ?? item.productId.slice(0, 8)}</td>
                    <td className="px-4 py-2">{item.serialNumber ?? '—'}</td>
                    <td className="px-4 py-2 text-right">
                      {item.valuePerUnit} {item.currencyCode}
                    </td>
                  </tr>
                ))}
                {(!stockPage?.data || stockPage.data.length === 0) && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-6 text-center text-sm text-[var(--color-muted-foreground)]"
                    >
                      No items available in that warehouse.
                    </td>
                  </tr>
                )}
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

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate({ to: '/stock' })}>
          Cancel
        </Button>
        <Button
          disabled={selectedIds.size === 0 || transferMutation.isPending}
          onClick={handleSubmit}
        >
          {transferMutation.isPending
            ? 'Transferring…'
            : `Transfer ${selectedIds.size} item(s)`}
        </Button>
      </div>
    </div>
  );
}
