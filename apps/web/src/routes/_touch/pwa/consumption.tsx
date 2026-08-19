import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { useBakes } from '@/features/recipes/use-recipes';
import { useExpectedConsumption } from '@/features/consumption/use-consumption';
import { useSubmitConsumption } from '@/features/pwa/use-pwa-jobs';
import { PwaSyncPill } from '@/features/pwa/queue-status';
import {
  TouchScreen,
  TouchTopbar,
  KeypadSheet,
  BottomSheet,
  BigButton,
  ActionBar,
  ErrorBanner,
  NumericKeypad,
  DiscardGuardSheet,
  selectOnFocus,
} from '@/components/touch/touch';
import { useNumericEntry } from '@/components/touch/use-numeric-entry';

export const Route = createFileRoute('/_touch/pwa/consumption')({
  component: ConsumptionScreen,
});

type EntryMode = 'CONSUMED' | 'REMAINING';

interface FormLine {
  productId: string;
  name: string;
  stockUom: string;
  expectedQty: number;
  /** One table's worth, straight from the recipe — what Table+ / Table− step
   *  by. Distinct from expectedQty, which is this times the table count. */
  qtyPerTable: number;
  actualQty: number;
  /** What's left, when this line is in REMAINING mode. The server derives the
   *  usage from stock on hand — the form never guesses it, because the opening
   *  it would have to assume is exactly what the server refuses to invent. */
  remainingQty: number;
  entryMode: EntryMode;
  wastageQty: number;
  wastageReason: string;
}

/** Quantities are stored to 2dp; repeatedly adding a fractional per-table
 *  amount otherwise drifts into 0.7500000000000001. */
const round2 = (n: number) => Math.round(n * 100) / 100;

const WASTE_REASONS = ['Spillage', 'Burnt', 'Dropped', 'Over-portioned', 'Off / expired'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Exported so the component tests can render the screen without a router. */
export function ConsumptionScreen() {
  const navigate = useNavigate();
  const { selectedSite, selectedSiteId, isBound } = useSiteContext();
  const { data: bakes } = useBakes();
  const expected = useExpectedConsumption();
  const submit = useSubmitConsumption();
  const { toast } = useToast();

  const [sessionId, setSessionId] = React.useState('');
  const [sessionDate, setSessionDate] = React.useState(today());
  const [bake, setBake] = React.useState('');
  // Three table counts, typed by the session leader. Teams bake together, so
  // tables drive ingredient use rather than head count.
  //
  // Regular starts NULL, not 0: a zero would be a legitimate answer that
  // happens to look like an unanswered question, and the form would happily
  // proceed having been told nothing. The diet counts DO start at 0, because
  // "none today" is the ordinary case and making someone confirm it every
  // session is friction for nothing.
  const [regularTables, setRegularTables] = React.useState<number | null>(null);
  const [gfTables, setGfTables] = React.useState(0);
  const [veganTables, setVeganTables] = React.useState(0);
  const covers = (regularTables ?? 0) + gfTables + veganTables;
  const [bakerName, setBakerName] = React.useState('');
  const [lines, setLines] = React.useState<FormLine[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  // sheets
  const [tableKeypad, setTableKeypad] = React.useState<'regular' | 'gf' | 'vegan' | null>(null);
  const [actualTarget, setActualTarget] = React.useState<number | null>(null);
  const [wasteTarget, setWasteTarget] = React.useState<number | null>(null);
  const [error, setError] = React.useState<{ title: string; message: string } | null>(null);
  // A-5: an edited ingredient list must not disappear on a stray Back.
  const [confirmExit, setConfirmExit] = React.useState(false);

  const loadExpected = async () => {
    if (!selectedSiteId || !bake.trim() || regularTables === null || covers <= 0) return;
    setError(null);
    let rows;
    try {
      rows = await expected.mutateAsync({
        siteId: selectedSiteId,
        onDate: sessionDate,
        bake: bake.trim(),
        covers,
        glutenFreeTables: gfTables,
        veganTables,
      });
    } catch (err) {
      setError({
        title: 'Could not load the recipe',
        message: err instanceof Error ? err.message : 'The request failed. Try again.',
      });
      return;
    }
    setLines(
      rows.map((r) => ({
        productId: r.productId,
        name: r.productName,
        stockUom: r.stockUom,
        expectedQty: r.expectedQty,
        qtyPerTable: r.qtyPerCover,
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
    setError(null);
    let res;
    try {
      res = await submit.mutateAsync({
        sessionId: sessionId.trim(),
        siteId: selectedSiteId,
        sessionDate,
        bakerName: bakerName.trim(),
        bake: bake.trim(),
        covers,
        glutenFreeTables: gfTables,
        veganTables,
        lines: lines.map((l) => ({
          productId: l.productId,
          entryMode: l.entryMode,
          actualQty: l.actualQty,
          remainingQty: l.remainingQty,
          wastageQty: l.wastageQty || undefined,
          wastageReason: l.wastageReason || null,
        })),
      });
    } catch (err) {
      setError({
        title: 'Not submitted',
        message: err instanceof Error ? err.message : 'Something went wrong. Your entries are still here.',
      });
      return;
    }
    if (res.status === 'rejected') {
      // Refused, not queued — the ingredient list stays exactly as entered.
      setError({
        title: 'Not submitted — the server refused this bake',
        message: res.error?.message ?? 'The bake was rejected. Your entries are still on this screen.',
      });
      return;
    }
    toast({ title: res.status === 'sent' ? 'Consumption recorded' : 'Saved offline — will sync' });
    setLines([]);
    setLoaded(false);
    setSessionId('');
    setRegularTables(null);
    setGfTables(0);
    setVeganTables(0);
  };

  // ── Setup screen ──────────────────────────────────────────
  if (!loaded) {
    return (
      <TouchScreen>
        <TouchTopbar
          title="End of bake"
          venue={selectedSite?.name ?? null}
        venueBound={isBound}
          onBack={() => void navigate({ to: '/' })}
        />
        <div className="scroll">
          {error && <ErrorBanner title={error.title} message={error.message} onDismiss={() => setError(null)} />}
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
              <label>Number of Regular Tables</label>
              <button
                className="input"
                style={{ textAlign: 'left', fontWeight: 700 }}
                onClick={() => setTableKeypad('regular')}
              >
                {regularTables !== null ? regularTables : 'Tap to enter'}
              </button>
            </div>

            <div className="field">
              <label>Number of Gluten Free Tables</label>
              <button
                className="input"
                style={{ textAlign: 'left', fontWeight: 700 }}
                onClick={() => setTableKeypad('gf')}
              >
                {gfTables}
              </button>
            </div>

            <div className="field">
              <label>Number of Vegan Tables</label>
              <button
                className="input"
                style={{ textAlign: 'left', fontWeight: 700 }}
                onClick={() => setTableKeypad('vegan')}
              >
                {veganTables}
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
              disabled={
                !selectedSiteId ||
                !bake.trim() ||
                regularTables === null ||
                covers <= 0 ||
                expected.isPending
              }
              onClick={() => void loadExpected()}
            >
              {expected.isPending ? 'Loading…' : 'Load ingredients →'}
            </BigButton>
          </div>
        </div>

        {tableKeypad && (
          <KeypadSheet
            title={
              tableKeypad === 'regular'
                ? 'Number of Regular Tables'
                : tableKeypad === 'gf'
                  ? 'Number of Gluten Free Tables'
                  : 'Number of Vegan Tables'
            }
            initial={
              tableKeypad === 'regular'
                ? (regularTables ?? 0)
                : tableKeypad === 'gf'
                  ? gfTables
                  : veganTables
            }
            allowDecimal={false}
            onCancel={() => setTableKeypad(null)}
            onConfirm={(v) => {
              const n = Math.max(0, Math.round(v));
              if (tableKeypad === 'regular') setRegularTables(n);
              else if (tableKeypad === 'gf') setGfTables(n);
              else setVeganTables(n);
              setTableKeypad(null);
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
        title="End of bake"
        venue={selectedSite?.name ?? null}
        venueBound={isBound}
        sub={bake || undefined}
        onBack={() => {
          // Only guard when something has actually been changed from the
          // pre-filled expectation — an untouched list is nothing to lose.
          if (changed > 0) setConfirmExit(true);
          else setLoaded(false);
        }}
        right={<PwaSyncPill />}
        stat={`${lines.length} ingredients · ${covers} tables${gfTables || veganTables ? ` (${gfTables} GF, ${veganTables} vegan)` : ''} · ${changed} adjusted`}
      />
      <div className="scroll">
        {error && <ErrorBanner title={error.title} message={error.message} onDismiss={() => setError(null)} />}
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
                  {/* What one table costs, so the Table+/− steps are legible
                      and a baker can sanity-check the total in their head. */}
                  {l.qtyPerTable > 0 && (
                    <span className="perTable">
                      {' · '}
                      {l.qtyPerTable} {l.stockUom} per table
                    </span>
                  )}
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
                {/* A whole table's worth in one press. Bakers think in tables,
                    not in kilograms, so stepping by 1 kg to correct one table
                    of flour is arithmetic they should not have to do. */}
                <button
                  className="step-table"
                  aria-label={`Remove one table of ${l.name}`}
                  disabled={l.qtyPerTable <= 0}
                  onClick={() =>
                    setLine(i, remaining
                      ? { remainingQty: Math.max(0, round2(l.remainingQty + l.qtyPerTable)) }
                      : { actualQty: Math.max(0, round2(l.actualQty - l.qtyPerTable)) })
                  }
                >
                  Table−
                </button>
                {/* What a press is worth, at a glance. Read-only — the count
                    is set on the first page. */}
                <span className="table-count" aria-hidden>
                  {covers}
                </span>
                <button
                  className="step-table"
                  aria-label={`Add one table of ${l.name}`}
                  disabled={l.qtyPerTable <= 0}
                  onClick={() =>
                    setLine(i, remaining
                      ? { remainingQty: Math.max(0, round2(l.remainingQty - l.qtyPerTable)) }
                      : { actualQty: round2(l.actualQty + l.qtyPerTable) })
                  }
                >
                  Table+
                </button>
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

      {confirmExit && (
        <DiscardGuardSheet
          title="Leave the bake?"
          message={`You have adjusted ${changed} ingredient${changed === 1 ? '' : 's'}. Leaving discards those changes.`}
          discardLabel="Discard them"
          onKeep={() => setConfirmExit(false)}
          onDiscard={() => {
            setConfirmExit(false);
            setLines([]);
            setLoaded(false);
          }}
        />
      )}

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

/**
 * Wastage entry.
 *
 * The keypad here was a near-duplicate of `KeypadSheet`'s, with the same D-4
 * append bug and the same missing keyboard support. Both now share
 * `useNumericEntry` + `NumericKeypad`, so the behaviour cannot drift apart
 * again (Aug-2026, D-4/D-5).
 */
function WastageSheet({
  line, onCancel, onSave,
}: {
  line: FormLine;
  onCancel: () => void;
  onSave: (qty: number, reason: string) => void;
}) {
  const entry = useNumericEntry({ initial: line.wastageQty });
  const [reason, setReason] = React.useState(line.wastageReason);
  const save = () => onSave(entry.valid ? entry.numeric : 0, reason.trim());

  return (
    <BottomSheet
      title={`${line.name} — wastage (${line.stockUom})`}
      onClose={onCancel}
      onKeyDown={(event) => {
        // Only while the keypad has focus — typing a reason must not be
        // intercepted digit by digit.
        const target = event.target as HTMLElement | null;
        if (target?.tagName === 'INPUT') return;
        const action = entry.handleKey(event);
        if (action === 'confirm') save();
        if (action === 'cancel') onCancel();
      }}
    >
      <NumericKeypad entry={entry} />
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="waste-reason">Reason</label>
        <div className="toolbar" style={{ padding: 0, background: 'transparent', border: 'none', flexWrap: 'wrap' }}>
          {WASTE_REASONS.map((r) => (
            <button key={r} type="button" className={`chip${reason === r ? ' on' : ''}`} onClick={() => setReason(r)}>{r}</button>
          ))}
        </div>
        <input
          id="waste-reason"
          className="input"
          style={{ marginTop: 10 }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onFocus={selectOnFocus}
          placeholder="or type a reason"
        />
      </div>
      <div className="sheet-actions">
        <BigButton variant="ghost" onClick={() => onSave(0, '')}>Clear</BigButton>
        <BigButton variant="solid" onClick={save}>Save</BigButton>
      </div>
    </BottomSheet>
  );
}
