import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { apiFetch, type PaginatedResult } from '@/lib/api-client';
import { useSiteContext } from '@/features/sites/site-context';
import { bucketCount } from '@/lib/uom';
import {
  useOpenStockTake,
  useRecordStockTakeCounts,
  useApproveStockTake,
} from '@/features/pwa/use-pwa-jobs';
import type { Product } from '@/lib/api-types';

export const Route = createFileRoute('/_authed/pwa/stock-take')({
  component: StockTakeScreen,
});

interface TakeLine {
  productId: string;
  bookQty: string;
}

function useProductMap() {
  return useQuery<Map<string, Product>>({
    queryKey: ['pwa-product-map'],
    queryFn: async () => {
      const res = await apiFetch<PaginatedResult<Product>>('/products', { searchParams: { pageSize: 500 } });
      const rows = Array.isArray(res) ? (res as Product[]) : res.data;
      return new Map(rows.map((p) => [p.id, p]));
    },
  });
}

function StockTakeScreen() {
  const { selectedSite, selectedSiteId } = useSiteContext();
  const { data: productMap } = useProductMap();
  const open = useOpenStockTake();
  const record = useRecordStockTakeCounts();
  const approve = useApproveStockTake();
  const { toast } = useToast();

  const [scope, setScope] = React.useState('FULL');
  const [takeId, setTakeId] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<TakeLine[]>([]);
  const [counts, setCounts] = React.useState<Record<string, string>>({});

  const startCount = async () => {
    if (!selectedSiteId) return;
    const res = await open.mutateAsync({ siteId: selectedSiteId, scope });
    setTakeId(res.data.take.id);
    setLines((res.data.lines as TakeLine[]) ?? []);
    setCounts({});
  };

  const submitCounts = async () => {
    if (!takeId) return;
    const counted = lines
      .filter((l) => counts[l.productId] !== undefined && counts[l.productId] !== '')
      .map((l) => {
        const uom = productMap?.get(l.productId)?.stockUom ?? 'each';
        return { productId: l.productId, countedQty: bucketCount(Number(counts[l.productId]), uom) };
      });
    if (counted.length === 0) return;
    const res = await record.mutateAsync({ stockTakeId: takeId, counts: counted });
    toast({ title: res.status === 'sent' ? 'Counts saved' : 'Saved offline — will sync' });
  };

  const approveTake = async () => {
    if (!takeId) return;
    await approve.mutateAsync(takeId);
    toast({ title: 'Stock-take approved — ledger trued up' });
    setTakeId(null);
    setLines([]);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Stock-take — {selectedSite?.name ?? '…'}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Count stock against the book figure; variance is trued up on approval.
        </p>
      </div>

      {!takeId && (
        <Card>
          <CardContent className="flex items-end gap-3 p-4">
            <div className="flex-1 space-y-1">
              <label className="text-sm">Scope</label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FULL">Full count</SelectItem>
                  <SelectItem value="CYCLE">Cycle count</SelectItem>
                  <SelectItem value="CATEGORY">Category</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => void startCount()} disabled={open.isPending}>
              <ClipboardCheck className="h-4 w-4" />
              {open.isPending ? 'Opening…' : 'Start count'}
            </Button>
          </CardContent>
        </Card>
      )}

      {takeId && (
        <>
          {lines.length === 0 && (
            <p className="text-sm text-[var(--color-muted-foreground)]">No stock lines in scope.</p>
          )}
          {lines.map((l) => {
            const product = productMap?.get(l.productId);
            const book = Number(l.bookQty);
            const counted = counts[l.productId];
            const variance = counted !== undefined && counted !== '' ? Number(counted) - book : null;
            return (
              <Card key={l.productId}>
                <CardContent className="space-y-2 p-4">
                  <div className="font-medium">{product?.name ?? l.productId.slice(0, 8)}</div>
                  <div className="grid grid-cols-3 items-end gap-3 text-sm">
                    <div>Book: {book} {product?.stockUom ?? ''}</div>
                    <Input
                      type="number"
                      inputMode="decimal"
                      placeholder="counted"
                      value={counted ?? ''}
                      onChange={(e) => setCounts((c) => ({ ...c, [l.productId]: e.target.value }))}
                    />
                    <div className={variance && variance !== 0 ? 'text-[var(--color-destructive)]' : ''}>
                      {variance === null ? '—' : `Δ ${variance}`}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={() => void submitCounts()} disabled={record.isPending}>
              {record.isPending ? 'Saving…' : 'Save counts'}
            </Button>
            <Button className="flex-1" onClick={() => void approveTake()} disabled={approve.isPending}>
              {approve.isPending ? 'Approving…' : 'Approve & true-up'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
