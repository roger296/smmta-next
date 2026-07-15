import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { resolveBarcodeToProduct } from '@/lib/barcode';
import { purchaseToStock } from '@/lib/uom';
import { useReceiveGoodsIn } from '@/features/pwa/use-pwa-jobs';
import type { Product } from '@/lib/api-types';
import {
  TouchScreen,
  TouchTopbar,
  KeypadSheet,
  BottomSheet,
  BigButton,
  ActionBar,
  SyncPill,
} from '@/components/touch/touch';

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
  const navigate = useNavigate();
  const { selectedSite, selectedSiteId } = useSiteContext();
  const receive = useReceiveGoodsIn();
  const { toast } = useToast();
  const [code, setCode] = React.useState('');
  const [lines, setLines] = React.useState<Line[]>([]);
  const [qtyTarget, setQtyTarget] = React.useState<number | null>(null);
  const [detailsTarget, setDetailsTarget] = React.useState<number | null>(null);

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
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, idx) => idx !== i));

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
    toast({ title: res.status === 'sent' ? 'Booked in' : 'Saved offline — will sync' });
    setLines([]);
  };

  const qt = qtyTarget !== null ? lines[qtyTarget] : undefined;
  const dt = detailsTarget !== null ? lines[detailsTarget] : undefined;

  return (
    <TouchScreen>
      <TouchTopbar
        title={`Goods in — ${selectedSite?.name ?? '…'}`}
        onBack={() => void navigate({ to: '/' })}
        right={<SyncPill state={receive.isPending ? 'syncing' : 'synced'} />}
        stat={lines.length > 0 ? `${lines.length} line${lines.length === 1 ? '' : 's'} to book in` : undefined}
      />

      <div className="toolbar">
        <input
          className="search"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addByCode()}
          placeholder="Scan / enter barcode or name"
          aria-label="Product code"
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button className="chip on" onClick={() => void addByCode()} style={{ minWidth: 72 }}>+ Add</button>
      </div>

      <div className="scroll">
        {lines.length === 0 && <div className="empty">Scan or type a product code to start booking stock in.</div>}
        {lines.map((l, i) => {
          const factor = Number(l.product.purchaseToStockFactor) || 1;
          const needBatch = l.product.requireBatchNumber && !l.batchCode;
          return (
            <div className="row" key={`${l.product.id}-${i}`}>
              <div className={`status status-${needBatch ? 'warn' : 'done'}`} aria-hidden="true">{needBatch ? '!' : '●'}</div>
              <div className="meta">
                <div className="name">{l.product.name}</div>
                <div className="hint">
                  = {purchaseToStock(l.qtyPurchase, factor)} {l.product.stockUom} · £{l.unitCost.toFixed(2)}/{l.product.purchaseUom ?? 'unit'}
                  {l.product.requireBatchNumber && (
                    <span className={`badge${needBatch ? ' warn' : ''}`} style={{ marginLeft: 6 }}>
                      {l.batchCode ? `batch ${l.batchCode}` : 'batch needed'}
                    </span>
                  )}
                </div>
              </div>
              <div className="qty-controls">
                <button className="step" aria-label="Decrease" onClick={() => update(i, { qtyPurchase: Math.max(0, Math.round((l.qtyPurchase - 1) * 100) / 100) })}>−</button>
                <button className="qty-value" aria-label="Type received quantity" onClick={() => setQtyTarget(i)}>{l.qtyPurchase}</button>
                <button className="step" aria-label="Increase" onClick={() => update(i, { qtyPurchase: Math.round((l.qtyPurchase + 1) * 100) / 100 })}>+</button>
                <button className="zero" aria-label="Cost & batch details" onClick={() => setDetailsTarget(i)}>£</button>
              </div>
            </div>
          );
        })}
      </div>

      <ActionBar>
        <BigButton variant="ok" disabled={lines.length === 0 || receive.isPending} onClick={() => void submit()}>
          {receive.isPending ? 'Booking in…' : `Book in ${lines.length} line${lines.length === 1 ? '' : 's'}`}
        </BigButton>
      </ActionBar>

      {qt && qtyTarget !== null && (
        <KeypadSheet
          title={`${qt.product.name} — received (${qt.product.purchaseUom ?? 'unit'})`}
          initial={qt.qtyPurchase}
          onCancel={() => setQtyTarget(null)}
          onConfirm={(v) => {
            update(qtyTarget, { qtyPurchase: v });
            setQtyTarget(null);
          }}
        />
      )}

      {dt && detailsTarget !== null && (
        <DetailsSheet
          line={dt}
          onCancel={() => setDetailsTarget(null)}
          onRemove={() => {
            removeLine(detailsTarget);
            setDetailsTarget(null);
          }}
          onSave={(patch) => {
            update(detailsTarget, patch);
            setDetailsTarget(null);
          }}
        />
      )}
    </TouchScreen>
  );
}

function DetailsSheet({
  line, onCancel, onRemove, onSave,
}: {
  line: Line;
  onCancel: () => void;
  onRemove: () => void;
  onSave: (patch: Partial<Line>) => void;
}) {
  const [unitCost, setUnitCost] = React.useState(String(line.unitCost));
  const [batchCode, setBatchCode] = React.useState(line.batchCode);
  const [useBy, setUseBy] = React.useState(line.useBy);
  return (
    <BottomSheet title={line.product.name} onClose={onCancel}>
      <div className="field">
        <label>Unit cost (£ per {line.product.purchaseUom ?? 'unit'})</label>
        <input className="input" type="number" inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
      </div>
      {line.product.requireBatchNumber && (
        <>
          <div className="field">
            <label>Batch code</label>
            <input className="input" value={batchCode} onChange={(e) => setBatchCode(e.target.value)} placeholder="e.g. M-2026-06" autoCapitalize="characters" />
          </div>
          <div className="field">
            <label>Use by</label>
            <input className="input" type="date" value={useBy} onChange={(e) => setUseBy(e.target.value)} />
          </div>
        </>
      )}
      <div className="sheet-actions">
        <BigButton variant="ghost" onClick={onRemove}>Remove line</BigButton>
        <BigButton variant="solid" onClick={() => onSave({ unitCost: Number(unitCost) || 0, batchCode, useBy })}>Save</BigButton>
      </div>
    </BottomSheet>
  );
}
