import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ChefHat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { useProductsList } from '@/features/products/use-products';
import { useBakes } from '@/features/recipes/use-recipes';
import { useExpectedConsumption } from '@/features/consumption/use-consumption';
import { useSubmitConsumption } from '@/features/pwa/use-pwa-jobs';

export const Route = createFileRoute('/_authed/pwa/consumption')({
  component: ConsumptionScreen,
});

interface FormLine {
  productId: string;
  stockUom: string;
  expectedQty: number;
  actualQty: number;
  wastageQty: number;
  wastageReason: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ConsumptionScreen() {
  const { selectedSite, selectedSiteId } = useSiteContext();
  const { data: productPage } = useProductsList({ pageSize: 500 });
  const { data: bakes } = useBakes();
  const expected = useExpectedConsumption();
  const submit = useSubmitConsumption();
  const { toast } = useToast();

  const productName = React.useCallback(
    (id: string) => (productPage?.data ?? []).find((p) => p.id === id)?.name ?? id.slice(0, 8),
    [productPage],
  );

  const [sessionId, setSessionId] = React.useState('');
  const [sessionDate, setSessionDate] = React.useState(today());
  const [bake, setBake] = React.useState('');
  const [covers, setCovers] = React.useState('');
  const [bakerName, setBakerName] = React.useState('');
  const [lines, setLines] = React.useState<FormLine[]>([]);

  const loadExpected = async () => {
    if (!selectedSiteId || !bake.trim() || !Number(covers)) return;
    const rows = await expected.mutateAsync({
      siteId: selectedSiteId,
      onDate: sessionDate,
      bake: bake.trim(),
      covers: Number(covers),
    });
    setLines(
      rows.map((r) => ({
        productId: r.productId,
        stockUom: r.stockUom,
        expectedQty: r.expectedQty,
        actualQty: r.expectedQty, // pre-filled with expected; baker edits
        wastageQty: 0,
        wastageReason: '',
      })),
    );
    if (rows.length === 0) toast({ title: 'No recipe found for that cake / date' });
  };

  const setLine = (i: number, patch: Partial<FormLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const canSubmit =
    !!selectedSiteId && !!sessionId.trim() && !!bakerName.trim() && lines.length > 0 && !submit.isPending;

  const doSubmit = async () => {
    if (!selectedSiteId) return;
    const res = await submit.mutateAsync({
      sessionId: sessionId.trim(),
      siteId: selectedSiteId,
      sessionDate,
      bakerName: bakerName.trim(),
      bake: bake.trim(),
      covers: Number(covers) || 0,
      lines: lines.map((l) => ({
        productId: l.productId,
        actualQty: l.actualQty,
        wastageQty: l.wastageQty || undefined,
        wastageReason: l.wastageReason || null,
      })),
    });
    toast({
      title: res.status === 'sent' ? 'Consumption recorded' : 'Saved offline — will sync when back online',
    });
    setLines([]);
    setSessionId('');
    setCovers('');
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">End-of-session — {selectedSite?.name ?? '…'}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Confirm what each ingredient actually used and any wastage. This decrements site stock and
          records variance against the expected recipe. Works offline — submissions sync when you
          reconnect.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Session ID</Label>
              <Input value={sessionId} onChange={(e) => setSessionId(e.target.value)} placeholder="BumbleBee session id" />
            </div>
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={sessionDate} onChange={(e) => setSessionDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Cake baked</Label>
              <Input
                list="bake-options"
                value={bake}
                onChange={(e) => setBake(e.target.value)}
                placeholder="e.g. Victoria Sponge"
              />
              <datalist id="bake-options">
                {(bakes ?? []).map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label>Covers (guests)</Label>
              <Input type="number" inputMode="numeric" value={covers} onChange={(e) => setCovers(e.target.value)} />
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => void loadExpected()}
            disabled={!bake.trim() || !Number(covers) || expected.isPending}
          >
            {expected.isPending ? 'Loading…' : 'Load expected quantities'}
          </Button>
        </CardContent>
      </Card>

      {lines.map((l, i) => (
        <Card key={l.productId}>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div className="font-medium">{productName(l.productId)}</div>
              <div className="text-sm text-[var(--color-muted-foreground)]">
                expected {l.expectedQty} {l.stockUom}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label>Actual ({l.stockUom})</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={l.actualQty}
                  onChange={(e) => setLine(i, { actualQty: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1">
                <Label>Wastage</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={l.wastageQty}
                  onChange={(e) => setLine(i, { wastageQty: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1">
                <Label>Wastage reason</Label>
                <Input
                  value={l.wastageReason}
                  onChange={(e) => setLine(i, { wastageReason: e.target.value })}
                  placeholder="e.g. spillage"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardContent className="space-y-1 p-4">
          <Label>Your name (who baked this)</Label>
          <Input value={bakerName} onChange={(e) => setBakerName(e.target.value)} placeholder="Baker name" />
        </CardContent>
      </Card>

      <Button className="w-full" size="lg" onClick={() => void doSubmit()} disabled={!canSubmit}>
        <ChefHat className="h-4 w-4" />
        {submit.isPending ? 'Submitting…' : 'Submit consumption'}
      </Button>
    </div>
  );
}
