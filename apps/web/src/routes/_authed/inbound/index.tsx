import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Ship, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/format';
import {
  useShipments,
  useShipment,
  useCreateShipment,
  useUpdateEta,
  useGoodsIn,
  type Shipment,
  type ShipmentMode,
} from '@/features/inbound/use-inbound';

/**
 * Inbound shipments (SPEC F1). Operator surface for pre-order stock pools:
 * list, create, edit ETA, and record goods-in.
 */
export const Route = createFileRoute('/_authed/inbound/')({
  component: InboundPage,
});

const MODES: ShipmentMode[] = ['sea', 'air', 'road', 'rail', 'courier'];

function InboundPage() {
  const { data: shipments, isLoading } = useShipments();
  const [creating, setCreating] = React.useState(false);
  const [manageId, setManageId] = React.useState<string | null>(null);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inbound shipments</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">Pre-order stock pools in transit.</p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" /> New shipment
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {shipments && shipments.length === 0 && (
        <EmptyState icon={Ship} title="No inbound shipments" description="Create one to open a pre-order pool." />
      )}

      <div className="space-y-3">
        {shipments?.map((s) => (
          <ShipmentCard key={s.id} shipment={s} onManage={() => setManageId(s.id)} />
        ))}
      </div>

      <CreateShipmentDialog open={creating} onClose={() => setCreating(false)} />
      {manageId && <ManageShipmentDialog id={manageId} onClose={() => setManageId(null)} />}
    </div>
  );
}

function ShipmentCard({ shipment, onManage }: { shipment: Shipment; onManage: () => void }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{shipment.reference}</CardTitle>
          <div className="flex shrink-0 gap-1">
            <Badge variant="secondary">{shipment.mode}</Badge>
            <Badge variant={shipment.status === 'received' ? 'default' : 'outline'}>{shipment.status}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex items-center justify-between text-sm">
        <div className="text-[var(--color-muted-foreground)]">
          ETA {formatDate(shipment.eta)} · buffer {shipment.bufferPct}%
          {shipment.arrivedAt && ` · arrived ${formatDate(shipment.arrivedAt)}`}
        </div>
        <Button size="sm" variant="outline" onClick={onManage}>
          Manage
        </Button>
      </CardContent>
    </Card>
  );
}

function CreateShipmentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateShipment();
  const [reference, setReference] = React.useState('');
  const [mode, setMode] = React.useState<ShipmentMode>('sea');
  const [eta, setEta] = React.useState('');
  const [bufferPct, setBufferPct] = React.useState('8');
  const [linesText, setLinesText] = React.useState('');

  const submit = () => {
    const lines = linesText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [sku, qty] = l.split(',').map((x) => x.trim());
        return { sku: sku ?? '', qtyManifested: Number(qty) };
      })
      .filter((l) => l.sku && Number.isInteger(l.qtyManifested) && l.qtyManifested > 0);
    if (!reference || !eta || lines.length === 0) {
      toast({ title: 'Reference, ETA and at least one valid line are required', variant: 'destructive' });
      return;
    }
    create.mutate(
      { reference, mode, eta: new Date(eta).toISOString(), bufferPct: Number(bufferPct), lines },
      {
        onSuccess: () => {
          toast({ title: 'Shipment created' });
          onClose();
          setReference('');
          setEta('');
          setLinesText('');
        },
        onError: () => toast({ title: 'Could not create shipment', variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New inbound shipment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="ref">Reference</Label>
            <Input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="SEA-2026-070" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <Label>Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as ShipmentMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <Label htmlFor="buf">Buffer %</Label>
              <Input id="buf" type="number" value={bufferPct} onChange={(e) => setBufferPct(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="eta">ETA</Label>
            <Input id="eta" type="date" value={eta} onChange={(e) => setEta(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="lines">Lines (one per line: SKU,qty)</Label>
            <Textarea id="lines" rows={4} value={linesText} onChange={(e) => setLinesText(e.target.value)} placeholder={'FIL-PETG-BLK-175,480\nFIL-PLA-BLK-175,240'} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageShipmentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { toast } = useToast();
  const { data: detail, isLoading } = useShipment(id);
  const updateEta = useUpdateEta();
  const goodsIn = useGoodsIn();
  const [eta, setEta] = React.useState('');
  const [receipts, setReceipts] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (detail) {
      setEta(detail.eta.slice(0, 10));
      setReceipts(Object.fromEntries(detail.lines.map((l) => [l.sku, String(l.qtyManifested)])));
    }
  }, [detail]);

  const saveEta = () =>
    updateEta.mutate(
      { id, eta: new Date(eta).toISOString() },
      {
        onSuccess: () => toast({ title: 'ETA updated' }),
        onError: () => toast({ title: 'Could not update ETA', variant: 'destructive' }),
      },
    );

  const receive = () => {
    const list = Object.entries(receipts)
      .map(([sku, qty]) => ({ sku, qtyReceived: Number(qty) }))
      .filter((r) => Number.isInteger(r.qtyReceived) && r.qtyReceived >= 0);
    goodsIn.mutate(
      { id, receipts: list },
      {
        onSuccess: () => {
          toast({ title: 'Goods-in recorded', description: 'Stock bridged to the warehouse.' });
          onClose();
        },
        onError: () => toast({ title: 'Could not record goods-in', variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{detail?.reference ?? 'Shipment'}</DialogTitle>
        </DialogHeader>
        {isLoading || !detail ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="space-y-4">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="eta2">ETA</Label>
                <Input id="eta2" type="date" value={eta} onChange={(e) => setEta(e.target.value)} />
              </div>
              <Button size="sm" variant="outline" onClick={saveEta} disabled={updateEta.isPending}>
                Save ETA
              </Button>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">Goods-in (received quantities)</p>
              <div className="space-y-2">
                {detail.lines.map((l) => (
                  <div key={l.id} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 font-mono text-xs">{l.sku}</span>
                    <span className="text-[var(--color-muted-foreground)]">
                      {l.qtyManifested} manifested · {l.qtyPresold} presold
                    </span>
                    <Input
                      type="number"
                      className="w-24"
                      value={receipts[l.sku] ?? ''}
                      onChange={(e) => setReceipts((r) => ({ ...r, [l.sku]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={receive} disabled={goodsIn.isPending || !detail || detail.status === 'received'}>
            Record goods-in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
