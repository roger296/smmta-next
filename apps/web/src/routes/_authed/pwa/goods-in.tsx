import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PackagePlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { resolveBarcodeToProduct } from '@/lib/barcode';
import { purchaseToStock } from '@/lib/uom';
import { useReceiveGoodsIn } from '@/features/pwa/use-pwa-jobs';
import type { Product } from '@/lib/api-types';

export const Route = createFileRoute('/_authed/pwa/goods-in')({
  component: GoodsInScreen,
});

interface Line {
  product: Product;
  qtyPurchase: number;
  unitCost: number;
  batchCode: string;
  useBy: string;
}

function GoodsInScreen() {
  const { selectedSite, selectedSiteId } = useSiteContext();
  const receive = useReceiveGoodsIn();
  const { toast } = useToast();
  const [code, setCode] = React.useState('');
  const [lines, setLines] = React.useState<Line[]>([]);

  const addByCode = async () => {
    if (!code.trim()) return;
    const product = await resolveBarcodeToProduct(code.trim());
    if (!product) {
      toast({ variant: 'destructive', title: `No product for "${code}"` });
      return;
    }
    setLines((ls) => [...ls, { product, qtyPurchase: 1, unitCost: Number(product.expectedNextCost) || 0, batchCode: '', useBy: '' }]);
    setCode('');
  };

  const update = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    if (!selectedSiteId || lines.length === 0) return;
    const res = await receive.mutateAsync({
      siteId: selectedSiteId,
      lines: lines.map((l) => ({
        productId: l.product.id,
        qtyPurchase: l.qtyPurchase,
        unitCost: l.unitCost,
        ...(l.product.requireBatchNumber ? { batchCode: l.batchCode, useBy: l.useBy || null } : {}),
      })),
    });
    toast({
      title: res.status === 'sent' ? 'Booked in' : 'Saved offline — will sync when back online',
    });
    setLines([]);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Goods in — {selectedSite?.name ?? '…'}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Scan or enter a product code, set the received quantity in purchase units, and submit.
          Works offline — submissions sync when you reconnect.
        </p>
      </div>

      <Card>
        <CardContent className="flex gap-2 p-4">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addByCode()}
            placeholder="Scan / enter barcode or name"
            aria-label="Product code"
          />
          <Button onClick={() => void addByCode()}>
            <PackagePlus className="h-4 w-4" />
            Add
          </Button>
        </CardContent>
      </Card>

      {lines.map((l, i) => {
        const factor = Number(l.product.purchaseToStockFactor) || 1;
        return (
          <Card key={`${l.product.id}-${i}`}>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <div className="font-medium">{l.product.name}</div>
                <Button variant="ghost" size="sm" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Received ({l.product.purchaseUom ?? 'unit'})</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={l.qtyPurchase}
                    onChange={(e) => update(i, { qtyPurchase: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Unit cost (£)</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={l.unitCost}
                    onChange={(e) => update(i, { unitCost: Number(e.target.value) })}
                  />
                </div>
              </div>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                = {purchaseToStock(l.qtyPurchase, factor)} {l.product.stockUom} into stock
              </p>
              {l.product.requireBatchNumber && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Batch code</Label>
                    <Input
                      value={l.batchCode}
                      onChange={(e) => update(i, { batchCode: e.target.value })}
                      placeholder="e.g. M-2026-06"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Use by</Label>
                    <Input type="date" value={l.useBy} onChange={(e) => update(i, { useBy: e.target.value })} />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Button
        className="w-full"
        size="lg"
        onClick={() => void submit()}
        disabled={lines.length === 0 || receive.isPending}
      >
        {receive.isPending ? 'Submitting…' : `Book in ${lines.length} line(s)`}
      </Button>
    </div>
  );
}
