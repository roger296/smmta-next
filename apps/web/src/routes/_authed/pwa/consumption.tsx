import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { useProductsList } from '@/features/products/use-products';
import { useBakes } from '@/features/recipes/use-recipes';
import { useExpectedConsumption } from '@/features/consumption/use-consumption';
import { useSubmitConsumption } from '@/features/pwa/use-pwa-jobs';
import {
  TouchScreen,
  TouchTopbar,
  KeypadSheet,
  BottomSheet,
  BigButton,
  ActionBar,
  SyncPill,
} from '@/components/touch/touch';

export const Route = createFileRoute('/_authed/pwa/consumption')({
  component: ConsumptionScreen,
});

type EntryMode = 'CONSUMED' | 'REMAINING';

interface FormLine {
  productId: string;
  name: string;
  stockUom: string;
  expectedQty: number;
  actualQty: number;
  /** What's left, when this line is in REMAINING mode. The server derives the
   *  usage from stock on hand — the form never guesses it, because the opening
   *  it would have to assume is exactly what the server refuses to invent. */
  remainingQty: number;
  entryMode: EntryMode;
  wastageQty: number;
  wastageReason: string;
}

const WASTE_REASONS = ['Spillage', 'Burnt', 'Dropped', 'Over-portioned', 'Off / expired'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ConsumptionScreen() {
  const navigate = useNavigate();
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
  const [covers, setCovers] = React.useState(0);
  const [bakerName, setBakerName] = React.useState('');
  const [lines, setLines] = React.useState<FormLine[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  // sheets
  const [coversKeypad, setCoversKeypad] = React.useState(false);
  const [actualTarget, setActualTarget] = React.useState<number | null>(null);
  const [wasteTarget, setWasteTarget] = React.useState<number | null>(null);

  const loadExpected = async () => {
    if (!selectedSiteId || !bake.trim() || covers <= 0) return;
    const rows = await expected.mutateAsync({
      siteId: selectedSiteId,
      onDate: sessionDate,
      bake: bake.trim(),
      covers,
    });
    setLines(
      rows.map((r) => ({
        productId: r.productId,
        name: productName(r.productId),
        stockUom: r.stockUom,
        expectedQty: r.expectedQty,
        actualQty: r.expectedQty, // pre-filled with expected; baker edits
        remainingQty: 0,
        entryMode: 'CONSUMED' as EntryMode,
        wastageQty: 0,
        wastageReason: '',
      })),
    );
    setLoaded(true);
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
      covers,
      lines: lines.map((l) => ({
        productId: l.productId,
        entryMode: l.entryMode,
        actualQty: l.actualQty,
        remainingQty: l.remainingQty,
        wastageQty: l.wastageQty || undefined,
        wastageReason: l.wastageReason || null,
      })),
    });
    toast({ title: res.status === 'sent' ? 'Consumption recorded' : 'Saved offline — will sync' });
    setLines([]);
    setLoaded(false);
    setSessionId('');
    setCovers(0);
  };

  // ── Setup screen ──────────────────────────────────────────
  if (!loaded) {
    return (
      <TouchScreen>
        <TouchTopbar title="End of bake" onBack={() => void navigate({ to: '/' })} />
        <div className="scroll">
          <div className="center">
            <h1>{selectedSite?.name ?? 'Select a site'}</h1>
            <p className="lede">Pick the cake and how many guests baked it, then confirm what was actually used.</p>

            <div className="field">
              <label>Cake baked</label>
              <div className="tile-grid">
                {(bakes ?? []).map((b) => (
                  <button key={b} className={`tile${bake === b ? ' on' : ''}`} onClick={() => setBake(b)}>
                    {b}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Covers (guests)</label>
              <button className="input" style={{ textAlign: 'left', fontWeight: 700 }} onClick={() => setCoversKeypad(true)}>
                {covers > 0 ? covers : 'Tap to enter'}
              </button>
            </div>

            <div className="field">
              <label>Date</label>
              <input className="input" type="date" value={sessionDate} onChange={(e) => setSessionDate(e.target.value)} />
            </div>

            <div className="field">
              <label>Session ID</label>
              <input className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)} placeholder="BumbleBee session id" />
            </div>

            <div className="field">
              <label>Your name (who baked this)</label>
              <input className="input" value={bakerName} onChange={(e) => setBakerName(e.target.value)} placeholder="Baker name" autoCapitalize="words" />
            </div>

            <BigButton
              variant="solid"
              disabled={!selectedSiteId || !bake.trim() || covers <= 0 || expected.isPending}
              onClick={() => void loadExpected()}
            >
              {expected.isPending ? 'Loading…' : 'Load ingredients →'}
            </BigButton>
          </div>
        </div>

        {coversKeypad && (
          <KeypadSheet
            title="Covers (guests)"
            initial={covers}
            allowDecimal={false}
            onCancel={() => setCoversKeypad(false)}
            onConfirm={(v) => {
              setCovers(Math.round(v));
              setCoversKeypad(false);
            }}
          />
        )}
      </TouchScreen>
    );
  }

  // ── Ingredients screen ────────────────────────────────────
  const changed = lines.filter((l) => l.actualQty !== l.expectedQty || l.wastageQty > 0).length;
  const at = actualTarget !== null ? lines[actualTarget] : undefined;
  const wt = wasteTarget !== null ? lines[wasteTarget] : undefined;

  return (
    <TouchScreen>
      <TouchTopbar
        title={selectedSite?.name ?? 'End of bake'}
        sub={bake || undefined}
        onBack={() => setLoaded(false)}
        right={<SyncPill state={submit.isPending ? 'syncing' : 'synced'} />}
        stat={`${lines.length} ingredients · ${covers} covers · ${changed} adjusted`}
      />
      <div className="scroll">
        {lines.length === 0 && <div className="empty">No ingredients for that recipe.</div>}
        {lines.map((l, i) => {
          const remaining = l.entryMode === 'REMAINING';
          // In REMAINING mode the row edits `remainingQty`; the usage is the
          // server's to derive, so the form deliberately shows no consumed
          // figure it hasn't been told.
          const qty = remaining ? l.remainingQty : l.actualQty;
          const variance = Math.round((l.actualQty - l.expectedQty) * 100) / 100;
          const dot = l.wastageQty > 0 ? 'warn' : variance === 0 ? 'done' : 'warn';
          const bump = (by: number) =>
            setLine(i, remaining
              ? { remainingQty: Math.max(0, Math.round((l.remainingQty + by) * 100) / 100) }
              : { actualQty: Math.max(0, Math.round((l.actualQty + by) * 100) / 100) });
          return (
            <div className={`row mode-${remaining ? 'remaining' : 'consumed'}`} key={l.productId}>
              <div className={`status status-${dot}`} aria-hidden="true">{dot === 'done' ? '●' : '!'}</div>
              <div className="meta">
                <div className="name">{l.name}</div>
                {/* Both words AND colour — the number means opposite things in
                    the two modes, so this must never be read at a glance. */}
                <button
                  type="button"
                  className={`mode-toggle ${remaining ? 'remaining' : 'consumed'}`}
                  aria-pressed={remaining}
                  onClick={() =>
                    setLine(i, {
                      entryMode: remaining ? 'CONSUMED' : 'REMAINING',
                      // Reset the figure being switched away from, so a value
                      // typed as "used" can't survive as "left".
                      ...(remaining ? { remainingQty: 0 } : { actualQty: 0 }),
                    })
                  }
                >
                  {remaining ? "ENTERING: WHAT'S LEFT — tap to switch" : 'ENTERING: AMOUNT USED — tap to switch'}
                </button>
                <div className="hint book">
                  Expected {l.expectedQty} {l.stockUom}
                  {!remaining && variance !== 0 && <span className="badge warn" style={{ marginLeft: 6 }}>Δ {variance > 0 ? '+' : ''}{variance}</span>}
                  {l.wastageQty > 0 && <span className="badge" style={{ marginLeft: 6 }}>waste {l.wastageQty}{l.wastageReason ? ` · ${l.wastageReason}` : ''}</span>}
                </div>
              </div>
              <div className="qty-controls">
                <button className="step" aria-label="Decrease" onClick={() => bump(-1)}>−</button>
                <button
                  className={`qty-value ${remaining ? 'remaining' : ''}`}
                  aria-label={remaining ? `Type what is left of ${l.name}` : `Type amount of ${l.name} used`}
                  onClick={() => setActualTarget(i)}
                >
                  {qty}
                </button>
                <button className="step" aria-label="Increase" onClick={() => bump(1)}>+</button>
                <button className={`zero${l.wastageQty > 0 ? ' on' : ''}`} aria-label="Wastage" onClick={() => setWasteTarget(i)}>⚠</button>
              </div>
            </div>
          );
        })}
      </div>

      <ActionBar>
        <BigButton variant="ok" disabled={!canSubmit} onClick={() => void doSubmit()}>
          {submit.isPending ? 'Submitting…' : 'Submit consumption'}
        </BigButton>
      </ActionBar>

      {at && actualTarget !== null && (
        <KeypadSheet
          title={`${at.name} — actual (${at.stockUom})`}
          initial={at.entryMode === 'REMAINING' ? at.remainingQty : at.actualQty}
          onCancel={() => setActualTarget(null)}
          onConfirm={(v) => {
            setLine(
              actualTarget,
              at.entryMode === 'REMAINING' ? { remainingQty: v } : { actualQty: v },
            );
            setActualTarget(null);
          }}
        />
      )}

      {wt && wasteTarget !== null && (
        <WastageSheet
          line={wt}
          onCancel={() => setWasteTarget(null)}
          onSave={(qty, reason) => {
            setLine(wasteTarget, { wastageQty: qty, wastageReason: reason });
            setWasteTarget(null);
          }}
        />
      )}
    </TouchScreen>
  );
}

function WastageSheet({
  line, onCancel, onSave,
}: {
  line: FormLine;
  onCancel: () => void;
  onSave: (qty: number, reason: string) => void;
}) {
  const [value, setValue] = React.useState(line.wastageQty ? String(line.wastageQty) : '');
  const [reason, setReason] = React.useState(line.wastageReason);
  const push = (ch: string) =>
    setValue((v) => {
      if (ch === '.' && v.includes('.')) return v;
      if (ch === '.' && v === '') return '0.';
      if (v === '0' && ch !== '.') return ch;
      return (v + ch).slice(0, 9);
    });
  const num = Number(value) || 0;
  return (
    <BottomSheet title={`${line.name} — wastage (${line.stockUom})`} onClose={onCancel}>
      <div className="keydisplay">{value || '0'}</div>
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button key={k} className="key" onClick={() => push(k)}>{k}</button>
        ))}
        <button className="key" onClick={() => push('.')}>.</button>
        <button className="key" onClick={() => push('0')}>0</button>
        <button className="key" onClick={() => setValue((v) => v.slice(0, -1))} aria-label="Backspace">⌫</button>
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label>Reason</label>
        <div className="toolbar" style={{ padding: 0, background: 'transparent', border: 'none', flexWrap: 'wrap' }}>
          {WASTE_REASONS.map((r) => (
            <button key={r} className={`chip${reason === r ? ' on' : ''}`} onClick={() => setReason(r)}>{r}</button>
          ))}
        </div>
        <input className="input" style={{ marginTop: 10 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="or type a reason" />
      </div>
      <div className="sheet-actions">
        <BigButton variant="ghost" onClick={() => onSave(0, '')}>Clear</BigButton>
        <BigButton variant="solid" onClick={() => onSave(num, reason.trim())}>Save</BigButton>
      </div>
    </BottomSheet>
  );
}
