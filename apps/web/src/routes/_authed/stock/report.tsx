import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { buildStockReportCsv, useStockReport } from '@/features/stock/use-stock';
import { useWarehouses } from '@/features/reference/use-reference';
import { formatMoney } from '@/lib/format';
import { Download } from 'lucide-react';

export const Route = createFileRoute('/_authed/stock/report')({
  component: StockReportPage,
});

function StockReportPage() {
  const { data: warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = React.useState('');
  const { data, isLoading } = useStockReport({ warehouseId: warehouseId || undefined });

  // Group by warehouse
  const groups = React.useMemo(() => {
    if (!data) return [];
    const byWarehouse = new Map<string, { name: string; rows: typeof data; total: number }>();
    for (const row of data) {
      const existing = byWarehouse.get(row.warehouseId) ?? {
        name: row.warehouseName,
        rows: [] as typeof data,
        total: 0,
      };
      existing.rows.push(row);
      existing.total += Number(row.totalValue);
      byWarehouse.set(row.warehouseId, existing);
    }
    return Array.from(byWarehouse.entries()).map(([id, g]) => ({ id, ...g }));
  }, [data]);

  const grandTotal = groups.reduce((sum, g) => sum + g.total, 0);

  const handleExport = () => {
    if (!data) return;
    const csv = buildStockReportCsv(data);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stock-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Stock valuation report</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Current stock grouped by warehouse.
          </p>
        </div>
        <Button variant="outline" onClick={handleExport} disabled={!data || data.length === 0}>
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>
      <Select
        value={warehouseId || 'all'}
        onValueChange={(v) => setWarehouseId(v === 'all' ? '' : v)}
      >
        <SelectTrigger className="w-64" aria-label="Filter by warehouse">
          <SelectValue placeholder="All warehouses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All warehouses</SelectItem>
          {warehouses?.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isLoading && <Skeleton className="h-64 w-full" />}
      {groups.length === 0 && !isLoading && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-[var(--color-muted-foreground)]">
            No stock to report.
          </CardContent>
        </Card>
      )}
      {groups.map((g) => (
        <Card key={g.id}>
          <CardHeader>
            <CardTitle>{g.name}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Product</th>
                  <th className="px-4 py-2 text-left font-medium">Stock code</th>
                  <th className="px-4 py-2 text-right font-medium">Qty</th>
                  <th className="px-4 py-2 text-right font-medium">Total value</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr
                    key={`${r.warehouseId}-${r.productId}`}
                    className="border-b border-[var(--color-border)] last:border-b-0"
                  >
                    <td className="px-4 py-2">{r.productName}</td>
                    <td className="px-4 py-2">{r.stockCode ?? '—'}</td>
                    <td className="px-4 py-2 text-right">{r.quantity}</td>
                    <td className="px-4 py-2 text-right">{formatMoney(r.totalValue)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-[var(--color-border)] bg-[var(--color-muted)]">
                  <td colSpan={3} className="px-4 py-2 text-right font-medium">
                    Subtotal
                  </td>
                  <td className="px-4 py-2 text-right font-semibold">{formatMoney(g.total)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}
      {groups.length > 0 && (
        <Card>
          <CardContent className="flex items-center justify-between p-6">
            <span className="text-lg font-semibold">Grand total</span>
            <span className="text-lg font-bold">{formatMoney(grandTotal)}</span>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
