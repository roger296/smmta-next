import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import {
  useStockLevels,
  useSaveReorderLevels,
  type ReorderEntry,
} from '@/features/stock/use-stock-levels';

export const Route = createFileRoute('/_authed/stock/reorder')({
  component: ReorderLevelsPage,
});

type Edit = { point: string; upTo: string; days: string };

function ReorderLevelsPage() {
  const { selectedSite, selectedSiteId, sites, isLoading: sitesLoading } = useSiteContext();
  const { data: levels, isLoading } = useStockLevels(selectedSiteId);
  const save = useSaveReorderLevels();
  const { toast } = useToast();
  const [edits, setEdits] = React.useState<Record<string, Edit>>({});

  const initial = (productId: string): Edit => {
    const row = levels?.find((r) => r.productId === productId);
    return {
      point: row?.reorderPoint != null ? String(Number(row.reorderPoint)) : '',
      upTo: row?.reorderUpTo != null ? String(Number(row.reorderUpTo)) : '',
      days: '',
    };
  };
  const cur = (productId: string): Edit => edits[productId] ?? initial(productId);
  const setField = (productId: string, field: keyof Edit, v: string) =>
    setEdits((e) => ({ ...e, [productId]: { ...cur(productId), [field]: v } }));

  const parse = (v: string): number | null | undefined =>
    v.trim() === '' ? undefined : Number(v);

  const handleSave = async () => {
    if (!selectedSiteId || !levels) return;
    const entries: ReorderEntry[] = Object.entries(edits).map(([productId, e]) => ({
      productId,
      siteId: selectedSiteId,
      reorderPoint: parse(e.point),
      reorderUpTo: parse(e.upTo),
      minDaysCover: parse(e.days),
    }));
    if (entries.length === 0) return;
    try {
      await save.mutateAsync(entries);
      setEdits({});
      toast({ title: 'Reorder levels saved' });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  if (!sitesLoading && sites.length === 0) {
    return <EmptyState icon={Gauge} title="No sites yet" description="Add a site first." />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Reorder levels — {selectedSite?.name ?? '…'}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Set the reorder point, par (reorder-up-to) and min days cover per product for the
          selected site. Auto-reorder triggers when on-hand falls to the reorder point.
        </p>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}

      {!isLoading && levels && levels.length === 0 && (
        <EmptyState
          icon={Gauge}
          title="No stock lines at this site yet"
          description="Reorder levels apply to products held at this site."
        />
      )}

      {!isLoading && levels && levels.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">On hand</th>
                  <th className="px-4 py-3 font-medium">Reorder point</th>
                  <th className="px-4 py-3 font-medium">Reorder up to (par)</th>
                  <th className="px-4 py-3 font-medium">Min days cover</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((row) => {
                  const e = cur(row.productId);
                  return (
                    <tr key={row.productId} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-4 py-2 font-medium">{row.productName}</td>
                      <td className="px-4 py-2 tabular-nums">
                        {Number(row.onHand)} {row.stockUom}
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          type="number"
                          className="h-8 w-28"
                          value={e.point}
                          onChange={(ev) => setField(row.productId, 'point', ev.target.value)}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          type="number"
                          className="h-8 w-28"
                          value={e.upTo}
                          onChange={(ev) => setField(row.productId, 'upTo', ev.target.value)}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          type="number"
                          className="h-8 w-24"
                          value={e.days}
                          onChange={(ev) => setField(row.productId, 'days', ev.target.value)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={save.isPending || Object.keys(edits).length === 0}>
          {save.isPending ? 'Saving…' : 'Save reorder levels'}
        </Button>
      </div>
    </div>
  );
}
