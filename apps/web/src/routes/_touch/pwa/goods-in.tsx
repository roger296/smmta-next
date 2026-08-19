import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { useRoles } from '@/features/auth/use-roles';
import { attachBarcodeToProduct, productBarcodeLookup, resolveBarcodeToProduct } from '@/lib/barcode';
import {
  costPerStockUnit,
  describePackLine,
  formatMoney,
  needsPurchaseUnit,
  packStepLabel,
} from '@/lib/pack';
import { useReceiveGoodsIn, useReverseGoodsIn } from '@/features/pwa/use-pwa-jobs';
import { updateExpectedCost } from '@/features/products/update-cost';
import type { Product } from '@/lib/api-types';
import { PwaSyncPill } from '@/features/pwa/queue-status';
import {
  TouchScreen,
  TouchTopbar,
  KeypadSheet,
  BottomSheet,
  BigButton,
  ActionBar,
  ErrorBanner,
  UndoBar,
} from '@/components/touch/touch';

export const Route = createFileRoute('/_touch/pwa/goods-in')({
  component: GoodsInScreen,
});

interface Line {
  product: Product;
  qtyPurchase: number;
  unitCost: number;
  batchCode: string;
  useBy: string;
}

/** Exported so the component tests can render the screen without a router. */
export function GoodsInScreen() {
  const navigate = useNavigate();
  const { selectedSite, selectedSiteId, isBound } = useSiteContext();
  const receive = useReceiveGoodsIn();
  const reverse = useReverseGoodsIn();
  // Reversing a receipt is site_manager+ (E-4). A head baker sees the booking
  // confirmed but not an Undo they would only be refused — the confirmation
  // step (E-5) is their safeguard, and a site manager can still void it.
  const { can } = useRoles();
  const mayReverse = can(['site_manager']);
  // Editing a cost is site_manager+ server-side too (E-4); hiding it here
  // keeps a head baker out of a control they would only be refused.
  const mayEditCost = can(['site_manager']);
  const { toast } = useToast();
  const [code, setCode] = React.useState('');
  const [lines, setLines] = React.useState<Line[]>([]);
  const [qtyTarget, setQtyTarget] = React.useState<number | null>(null);
  const [detailsTarget, setDetailsTarget] = React.useState<number | null>(null);
  // A rejection is shown in the screen and stays there until dismissed — a
  // toast vanishes while the user is still looking at the shelf (defect A-1).
  const [error, setError] = React.useState<{ title: string; message: string } | null>(null);
  // Book-in is a two-step now (defect E-5): confirm the DESTINATION VENUE and
  // the lines before anything is written. 100 kg landing at the wrong venue is
  // not a slip anyone should be able to make in one tap.
  const [confirming, setConfirming] = React.useState(false);
  // After a successful booking, a 90-second window in which one tap issues a
  // reversing receipt (defect E-3).
  const [undo, setUndo] = React.useState<{ receiptId: string; venue: string } | null>(null);
  // A miss is a fork in the road, not a dead end (defect C-3). This holds the
  // code that failed so the sheet can offer: search by name, or attach this
  // code to a product so the NEXT delivery scans first time.
  const [missCode, setMissCode] = React.useState<string | null>(null);

  const addByCode = async () => {
    if (!code.trim()) return;
    // Defect A-6: a lookup that threw used to do nothing at all — no product
    // added, no error, the code still sitting in the box.
    let product: Product | null = null;
    try {
      product = await resolveBarcodeToProduct(code.trim());
    } catch (err) {
      setError({
        title: 'Could not look that code up',
        message: err instanceof Error ? err.message : 'The search request failed. Check the connection and try again.',
      });
      return;
    }
    if (!product) {
      // Not an error banner and not a destructive toast: a sheet that offers
      // the two things a baker standing at a delivery actually wants (C-3).
      setMissCode(code.trim());
      return;
    }
    setError(null);
    setLines((ls) => [...ls, { product: product!, qtyPurchase: 1, unitCost: Number(product!.expectedNextCost) || 0, batchCode: '', useBy: '' }]);
    setCode('');
  };

  const update = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!selectedSiteId || lines.length === 0) return;
    setConfirming(false);
    setError(null);
    let res;
    try {
      res = await receive.mutateAsync({
        siteId: selectedSiteId,
        lines: lines.map((l) => ({
          productId: l.product.id,
          qtyPurchase: l.qtyPurchase,
          unitCost: l.unitCost,
          ...(l.product.requireBatchNumber ? { batchCode: l.batchCode, useBy: l.useBy || null } : {}),
        })),
      });
    } catch (err) {
      // submitOrQueue only throws on something it could not classify at all.
      setError({
        title: 'Not booked in',
        message: err instanceof Error ? err.message : 'Something went wrong. Your lines are still here.',
      });
      return;
    }

    if (res.status === 'rejected') {
      // The server refused this. It will refuse it again, so nothing is
      // queued — and the lines stay on screen so the user can fix them.
      setError({
        title: 'Not booked in — the server refused this delivery',
        message: res.error?.message ?? 'The delivery was rejected. Your lines are still here.',
      });
      return;
    }

    if (res.status === 'sent' && res.data?.receipt?.id && mayReverse) {
      setUndo({ receiptId: res.data.receipt.id, venue: selectedSite?.name ?? 'this venue' });
    } else {
      // A queued booking has no receipt id yet, so there is nothing to undo —
      // and saying otherwise would be the A-1 lie in a different costume.
      setUndo(null);
    }
    toast({ title: res.status === 'sent' ? 'Booked in' : 'Saved offline — will sync' });
    setLines([]);
  };

  const doUndo = async () => {
    if (!undo) return;
    try {
      await reverse.mutateAsync({ receiptId: undo.receiptId });
    } catch (err) {
      setError({
        title: 'Could not undo that booking',
        message:
          err instanceof Error
            ? err.message
            : 'The reversal failed. A site manager can void the receipt from the admin.',
      });
      return;
    }
    setUndo(null);
    toast({ title: 'Booking reversed' });
  };

  const addProduct = (product: Product) => {
    setLines((ls) => [
      ...ls,
      {
        product,
        qtyPurchase: 1,
        unitCost: Number(product.expectedNextCost) || 0,
        batchCode: '',
        useBy: '',
      },
    ]);
    setCode('');
    setMissCode(null);
    setError(null);
  };

  // A line with no purchase unit cannot produce a defensible stock figure, so
  // it blocks the whole booking rather than quietly booking "1 g" (C-1).
  const blockedLines = lines.filter((l) => needsPurchaseUnit(l.product));

  const qt = qtyTarget !== null ? lines[qtyTarget] : undefined;
  const dt = detailsTarget !== null ? lines[detailsTarget] : undefined;

  return (
    <TouchScreen>
      <TouchTopbar
        title="Goods in"
        venue={selectedSite?.name ?? null}
        venueBound={isBound}
        onBack={() => void navigate({ to: '/' })}
        right={<PwaSyncPill />}
        stat={lines.length > 0 ? `${lines.length} line${lines.length === 1 ? '' : 's'} to book in` : undefined}
      />

      <div className="toolbar">
        {/* No autoFocus (defect B-2). On a shared venue iPad the keyboard must
            open when someone taps the field, not when the page loads — an
            unbidden keyboard shrinks the visual viewport on arrival and takes
            the top of the screen with it. */}
        <input
          className="search"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addByCode()}
          placeholder="Scan or type a code"
          aria-label="Product code"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button className="chip on" onClick={() => void addByCode()} style={{ minWidth: 72 }}>+ Add</button>
      </div>

      <div className="scroll">
        {error && (
          <ErrorBanner title={error.title} message={error.message} onDismiss={() => setError(null)} />
        )}
        {lines.length === 0 && <div className="empty">Scan or type a product code to start booking stock in.</div>}
        {lines.map((l, i) => {
          const needBatch = l.product.requireBatchNumber && !l.batchCode;
          // A product with no purchase unit cannot be booked (C-1). Silence
          // here is what produced the 1 g booking: a 25 kg sack and a product
          // genuinely bought by the gram look identical without it.
          const blocked = needsPurchaseUnit(l.product);
          const status = blocked || needBatch ? 'warn' : 'done';
          return (
            <div className="row" key={`${l.product.id}-${i}`}>
              <div className={`status status-${status}`} aria-hidden="true">{status === 'warn' ? '!' : '●'}</div>
              <div className="meta">
                <div className="name">{l.product.name}</div>
                <div className="hint">
                  {/* "4 × 25 kg sack = 100 kg" — quantity, pack, and the
                      resolved amount in a unit a person uses (C-1/C-2). */}
                  {describePackLine(l.qtyPurchase, l.product)}
                  {' · '}
                  {formatMoney(l.unitCost)}/{l.product.purchaseUom ?? 'unit'}
                  {!blocked && (
                    <span className="perStock">
                      {' ('}
                      {formatMoney(costPerStockUnit(l.unitCost, l.product))}/{l.product.stockUom}
                      {')'}
                    </span>
                  )}
                  {blocked && (
                    <span className="badge warn" style={{ marginLeft: 6 }}>
                      no purchase unit — set one to book this in
                    </span>
                  )}
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
                {/* Base-unit increment buttons (C-6): "auto-filling to 25kg and
                    adding +25kg per click". They step by ONE PURCHASE UNIT and
                    are labelled with it, so the press means what it says. Same
                    .step-table sizing as the End of Bake table buttons. */}
                <button
                  className="step-table"
                  aria-label={`Remove one ${l.product.purchaseUom ?? 'pack'} of ${l.product.name}`}
                  disabled={blocked}
                  onClick={() => update(i, { qtyPurchase: Math.max(0, Math.round((l.qtyPurchase - 1) * 100) / 100) })}
                >
                  {packStepLabel(l.product, '−')}
                </button>
                <button
                  className="step-table"
                  aria-label={`Add one ${l.product.purchaseUom ?? 'pack'} of ${l.product.name}`}
                  disabled={blocked}
                  onClick={() => update(i, { qtyPurchase: Math.round((l.qtyPurchase + 1) * 100) / 100 })}
                >
                  {packStepLabel(l.product, '+')}
                </button>
                <button className="zero" aria-label="Cost & batch details" onClick={() => setDetailsTarget(i)}>£</button>
              </div>
            </div>
          );
        })}
      </div>

      {undo && (
        <UndoBar
          message={`Booked to ${undo.venue}`}
          actionLabel={reverse.isPending ? 'Undoing…' : 'Undo'}
          disabled={reverse.isPending}
          seconds={90}
          onAction={() => void doUndo()}
          onExpire={() => setUndo(null)}
        />
      )}

      <ActionBar>
        <BigButton
          variant="ok"
          disabled={lines.length === 0 || blockedLines.length > 0 || receive.isPending}
          onClick={() => setConfirming(true)}
        >
          {receive.isPending
            ? 'Booking in…'
            : blockedLines.length > 0
              ? `${blockedLines.length} line${blockedLines.length === 1 ? '' : 's'} need a purchase unit`
              : `Book in ${lines.length} line${lines.length === 1 ? '' : 's'}`}
        </BigButton>
      </ActionBar>

      {missCode && (
        <CodeMissSheet
          code={missCode}
          onClose={() => setMissCode(null)}
          onPick={addProduct}
          onAttached={addProduct}
          onError={(message) => {
            setMissCode(null);
            setError({ title: 'Could not attach that code', message });
          }}
        />
      )}

      {confirming && (
        <ConfirmBookingSheet
          venue={selectedSite?.name ?? 'No venue set'}
          venueBound={isBound}
          lines={lines}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void submit()}
        />
      )}

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
          mayEditCost={mayEditCost}
          onSaveDefaultCost={async (cost) => {
            try {
              const updated = await updateExpectedCost(dt.product.id, cost);
              update(detailsTarget, { product: updated, unitCost: cost });
              toast({ title: 'Expected cost saved' });
            } catch (err) {
              setError({
                title: 'Could not save that cost',
                message: err instanceof Error ? err.message : 'The update was refused.',
              });
            }
          }}
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
  line, onCancel, onRemove, onSave, onSaveDefaultCost, mayEditCost,
}: {
  line: Line;
  onCancel: () => void;
  onRemove: () => void;
  onSave: (patch: Partial<Line>) => void;
  onSaveDefaultCost: (cost: number) => Promise<void>;
  mayEditCost: boolean;
}) {
  const [unitCost, setUnitCost] = React.useState(String(line.unitCost));
  const [batchCode, setBatchCode] = React.useState(line.batchCode);
  const [useBy, setUseBy] = React.useState(line.useBy);
  const [savingDefault, setSavingDefault] = React.useState(false);
  const parsedCost = Number(unitCost) || 0;

  return (
    <BottomSheet title={line.product.name} onClose={onCancel}>
      <div className="field">
        {/* Associated by id — the label was floating free, so a screen reader
            (and every by-label query) could not tie it to the input. */}
        <label htmlFor="gi-unit-cost">Unit cost (£ per {line.product.purchaseUom ?? 'unit'})</label>
        {/* `any` step, not 0.01 (defect C-4): an ingredient priced per gram is
            genuinely a fraction of a penny, and a 2dp step made those prices
            impossible to enter as well as impossible to store. */}
        <input
          id="gi-unit-cost"
          className="input"
          type="number"
          step="any"
          inputMode="decimal"
          value={unitCost}
          onChange={(e) => setUnitCost(e.target.value)}
        />
        <p className="hint" style={{ marginTop: 6 }}>
          {formatMoney(parsedCost)} per {line.product.purchaseUom ?? 'unit'}
          {' · '}
          {formatMoney(costPerStockUnit(parsedCost, line.product))} per {line.product.stockUom}
        </p>
      </div>

      {/* C-5: "Set £" could not write a price back, which is what the tester
          could not reach. site_manager+ only — a cost moves money (E-4). */}
      {mayEditCost && (
        <div className="field">
          <BigButton
            variant="outline"
            disabled={savingDefault || !(parsedCost > 0)}
            onClick={async () => {
              setSavingDefault(true);
              try {
                await onSaveDefaultCost(parsedCost);
              } finally {
                setSavingDefault(false);
              }
            }}
          >
            {savingDefault ? 'Saving…' : 'Also save as this product\u2019s expected cost'}
          </BigButton>
        </div>
      )}
      {line.product.requireBatchNumber && (
        <>
          <div className="field">
            <label htmlFor="gi-batch-code">Batch code</label>
            <input id="gi-batch-code" className="input" value={batchCode} onChange={(e) => setBatchCode(e.target.value)} placeholder="e.g. M-2026-06" autoCapitalize="characters" />
          </div>
          <div className="field">
            <label htmlFor="gi-use-by">Use by</label>
            <input id="gi-use-by" className="input" type="date" value={useBy} onChange={(e) => setUseBy(e.target.value)} />
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

/**
 * Confirm the destination before booking (defect E-5).
 *
 * "Accidental booking logged 100kg to Birmingham." The venue goes first and
 * biggest, because that is the fact that was wrong; the lines are restated in
 * the form a human checks — "4 × 25 kg sack = 100 kg" — rather than in the raw
 * numbers the form happens to hold. Cancel returns with every entry intact.
 */
export function ConfirmBookingSheet({
  venue, venueBound, lines, onCancel, onConfirm,
}: {
  venue: string;
  venueBound: boolean;
  lines: Line[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <BottomSheet title="Book this delivery in?" onClose={onCancel}>
      <div className="confirm-venue">
        <span className="confirm-venue-label">Booking to</span>
        <span className={`confirm-venue-name${venueBound ? '' : ' warn'}`}>{venue}</span>
        {!venueBound && (
          <span className="confirm-venue-warn">
            This venue was not set for this device — check it before confirming.
          </span>
        )}
      </div>

      <div className="confirm-lines">
        <div className="confirm-count">
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </div>
        {lines.map((l, i) => (
          <div className="confirm-line" key={`${l.product.id}-${i}`}>
            <span className="confirm-line-name">{l.product.name}</span>
            <span className="confirm-line-qty">{describeLine(l)}</span>
          </div>
        ))}
      </div>

      <div className="sheet-actions">
        <BigButton variant="ghost" onClick={onCancel}>Cancel</BigButton>
        <BigButton variant="ok" onClick={onConfirm}>Confirm and book in</BigButton>
      </div>
    </BottomSheet>
  );
}

/** "4 × 25 kg sack = 100 kg" — the line as a human checks it. */
export function describeLine(line: Line): string {
  return describePackLine(line.qtyPurchase, line.product);
}

/**
 * What to do when a code finds nothing (defect C-3).
 *
 * "Manual barcode entry failed to find the product for an icing sugar
 * delivery." The old behaviour was a destructive toast and nothing else — a
 * dead end at the exact moment someone is holding a delivery note and a pallet.
 *
 * Two ways forward, which is what the tester needed on both the icing sugar
 * and the Skittles:
 *
 *  1. **Search by name** — the code is wrong or unrecorded, but the product
 *     exists. Goods In had no name-search UI at all despite the placeholder
 *     saying "or name".
 *  2. **Attach this code** to the product you find, so the next delivery
 *     scans first time. This is the one that stops the problem recurring.
 */
export function CodeMissSheet({
  code, onClose, onPick, onAttached, onError,
}: {
  code: string;
  onClose: () => void;
  onPick: (product: Product) => void;
  onAttached: (product: Product) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<Product[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [attaching, setAttaching] = React.useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      setResults(await productBarcodeLookup(query.trim()));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'The search failed.');
    } finally {
      setSearching(false);
    }
  };

  const attach = async (product: Product) => {
    setAttaching(product.id);
    try {
      const updated = await attachBarcodeToProduct(product.id, code);
      onAttached(updated);
    } catch (err) {
      onError(
        err instanceof Error
          ? err.message
          : `Could not put ${code} on ${product.name}.`,
      );
    } finally {
      setAttaching(null);
    }
  };

  return (
    <BottomSheet title={`Nothing found for "${code}"`} onClose={onClose}>
      <p className="lede">Search for the product by name, then add it — or put this code on it so the next delivery scans first time.</p>

      <div className="toolbar" style={{ padding: 0, background: 'transparent', border: 'none' }}>
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
          placeholder="e.g. icing sugar"
          aria-label="Search products by name"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button className="chip on" onClick={() => void search()} disabled={searching} style={{ minWidth: 88 }}>
          {searching ? '…' : 'Search'}
        </button>
      </div>

      {results !== null && results.length === 0 && (
        <div className="queue-empty">Nothing matches "{query}". Try a shorter name.</div>
      )}

      {results?.map((product) => (
        <div className="queue-item" key={product.id}>
          <div className="queue-meta">
            <div className="queue-label">{product.name}</div>
            <div className="queue-sub">
              {product.stockCode ?? 'no stock code'}
              {product.barcode ? ` · barcode ${product.barcode}` : ' · no barcode yet'}
            </div>
          </div>
          <div className="queue-actions">
            <button onClick={() => onPick(product)}>Add</button>
            <button
              onClick={() => void attach(product)}
              disabled={attaching === product.id}
              aria-label={`Put code ${code} on ${product.name}`}
            >
              {attaching === product.id ? '…' : `Add code`}
            </button>
          </div>
        </div>
      ))}

      <div className="sheet-actions">
        <BigButton variant="ghost" onClick={onClose}>Close</BigButton>
      </div>
    </BottomSheet>
  );
}
