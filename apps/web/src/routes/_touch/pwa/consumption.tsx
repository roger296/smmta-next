import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { useBakes } from '@/features/recipes/use-recipes';
import {
  useDietaryCoverage,
  useExpectedConsumption,
  type ExpectedBlocker,
} from '@/features/consumption/use-consumption';
import { useSubmitConsumption } from '@/features/pwa/use-pwa-jobs';
import {
  blockedLines,
  bumpDisplayed,
  displayedQty,
  impliedBenches,
  isAdjusted,
  setDisplayed,
  statusOf,
  toggleMode,
  varianceOf,
  type ConsumptionLine,
} from '@/features/consumption/line-reducers';
import { PwaSyncPill } from '@/features/pwa/queue-status';
import {
  TouchScreen,
  TouchTopbar,
  KeypadSheet,
  BottomSheet,
  BigButton,
  ActionBar,
  ErrorBanner,
  BlockingNotice,
  NumericKeypad,
  DiscardGuardSheet,
  selectOnFocus,
} from '@/components/touch/touch';
import { useNumericEntry } from '@/components/touch/use-numeric-entry';

export const Route = createFileRoute('/_touch/pwa/consumption')({
  component: ConsumptionScreen,
});

/**
 * The line arithmetic lives in `features/consumption/line-reducers.ts` — the
 * F-1 / F-2 defects were arithmetic, and arithmetic is what a component test
 * pins down worst. See that file for the reasoning behind the direction rule
 * and the non-destructive toggle.
 */
type FormLine = ConsumptionLine;

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
  // Three bench counts, typed by the session leader. Teams bake together, so
  // benches drive ingredient use rather than head count. (A bench and a table
  // are the same thing — "bench" is the venue's word and the one on screen;
  // the API field names below still say "tables", which is the wire format.)
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
  // F-5: what the cake actually has a recipe for. Asked as soon as a cake is
  // picked, so the diet fields can refuse a number that would do nothing.
  const coverage = useDietaryCoverage({
    siteId: selectedSiteId ?? undefined,
    bake: bake.trim() || undefined,
    onDate: sessionDate,
  });
  const gfUnavailable = coverage.data ? !coverage.data.glutenFree : false;
  const veganUnavailable = coverage.data ? !coverage.data.vegan : false;
  // A count left over from a cake that DID have the variant must not survive a
  // change of cake — it would be disabled, invisible, and still submitted.
  React.useEffect(() => {
    if (gfUnavailable) setGfTables(0);
  }, [gfUnavailable]);
  React.useEffect(() => {
    if (veganUnavailable) setVeganTables(0);
  }, [veganUnavailable]);
  const [lines, setLines] = React.useState<FormLine[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  // sheets
  const [tableKeypad, setTableKeypad] = React.useState<'regular' | 'gf' | 'vegan' | null>(null);
  const [actualTarget, setActualTarget] = React.useState<number | null>(null);
  const [wasteTarget, setWasteTarget] = React.useState<number | null>(null);
  const [error, setError] = React.useState<{ title: string; message: string } | null>(null);
  // F-6: named reasons the bake cannot be filed. Held in state (not a toast)
  // because the whole defect was that the refusal did not persist on screen.
  const [blockers, setBlockers] = React.useState<ExpectedBlocker[]>([]);
  // A-5: an edited ingredient list must not disappear on a stray Back.
  const [confirmExit, setConfirmExit] = React.useState(false);

  const loadExpected = async () => {
    if (!selectedSiteId || !bake.trim() || regularTables === null || covers <= 0) return;
    setError(null);
    setBlockers([]);
    let result;
    try {
      result = await expected.mutateAsync({
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
    // F-6: refuse loudly and stay on the setup screen. Continuing into an
    // empty ingredient list is what let a whole evening's bakes go unrecorded.
    if (result.blockers.length > 0) {
      setBlockers(result.blockers);
      setLines([]);
      setLoaded(false);
      return;
    }
    const rows = result.lines;
    setLines(
      rows.map((r) => ({
        productId: r.productId,
        name: r.productName,
        stockUom: r.stockUom,
        expectedQty: r.expectedQty,
        qtyPerBench: r.qtyPerCover,
        actualQty: r.expectedQty, // pre-filled with expected; baker edits
        remainingQty: 0,
        // False until the baker has actually answered "what's left" — a
        // REMAINING line submitted as 0 without this claims an empty shelf.
        remainingSet: false,
        entryMode: 'CONSUMED' as const,
        wastageQty: 0,
        wastageReason: '',
      })),
    );
    setLoaded(true);
  };

  const setLine = (i: number, patch: Partial<FormLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));


  const canSubmit =
    !!selectedSiteId &&
    !!sessionId.trim() &&
    !!bakerName.trim() &&
    lines.length > 0 &&
    // F-8's guard: a REMAINING line with no figure would be sent as
    // `remainingQty: 0` — "the shelf is empty" — which is a very different
    // claim from "I haven't counted it".
    blockedLines(lines).length === 0 &&
    !submit.isPending;

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
          {blockers.length > 0 && (
            <BlockingNotice
              title="This bake cannot be recorded"
              detail={`${bake.trim() || 'No cake selected'} · ${sessionDate} · ${selectedSite?.name ?? 'no venue'}`}
              reasons={blockers}
            >
              <p style={{ margin: '8px 0 0', fontSize: 14 }}>
                Tell your site manager or head office — do not file a blank bake.
              </p>
            </BlockingNotice>
          )}
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
              {/* The label had no `for`, so nothing tied it to the control —
                  for a screen reader or for any by-label query. */}
              <label id="lbl-regular-benches">Number of Regular Benches</label>
              <button
                className="input"
                style={{ textAlign: 'left', fontWeight: 700 }}
                aria-labelledby="lbl-regular-benches"
                onClick={() => setTableKeypad('regular')}
              >
                {regularTables !== null ? regularTables : 'Tap to enter'}
              </button>
            </div>

            <div className="field">
              {/* The label had no `for`, so nothing tied it to the control —
                  for a screen reader or for any by-label query. */}
              <label id="lbl-gf-benches">Number of Gluten Free Benches</label>
              <button
                className="input"
                style={{ textAlign: 'left', fontWeight: 700 }}
                aria-labelledby="lbl-gf-benches"
                disabled={gfUnavailable}
                onClick={() => setTableKeypad('gf')}
              >
                {gfTables}
              </button>
              {/* F-5: accepting a number here when no GF variation exists
                  produced the standard recipe and looked like it had worked. */}
              {gfUnavailable && (
                <p className="field-note blocked">
                  No gluten-free recipe for this cake — ask head office.
                </p>
              )}
            </div>

            <div className="field">
              {/* The label had no `for`, so nothing tied it to the control —
                  for a screen reader or for any by-label query. */}
              <label id="lbl-vegan-benches">Number of Vegan Benches</label>
              <button
                className="input"
                style={{ textAlign: 'left', fontWeight: 700 }}
                aria-labelledby="lbl-vegan-benches"
                disabled={veganUnavailable}
                onClick={() => setTableKeypad('vegan')}
              >
                {veganTables}
              </button>
              {veganUnavailable && (
                <p className="field-note blocked">
                  No vegan recipe for this cake — ask head office.
                </p>
              )}
            </div>

            <div className="field">
              <label htmlFor="bake-date">Date</label>
              <input id="bake-date" className="input" type="date" value={sessionDate} onChange={(e) => setSessionDate(e.target.value)} />
            </div>

            <div className="field">
              <label htmlFor="bake-session-id">Session ID</label>
              <input id="bake-session-id" className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)} onFocus={selectOnFocus} placeholder="BumbleBee session id" />
            </div>

            <div className="field">
              <label htmlFor="bake-baker-name">Your name (who baked this)</label>
              <input id="bake-baker-name" className="input" value={bakerName} onChange={(e) => setBakerName(e.target.value)} onFocus={selectOnFocus} placeholder="Baker name" autoCapitalize="words" />
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
                ? 'Number of Regular Benches'
                : tableKeypad === 'gf'
                  ? 'Number of Gluten Free Benches'
                  : 'Number of Vegan Benches'
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
  // Computed from the mode ACTUALLY IN FORCE (F-2): a toggled line used to
  // count as "adjusted" purely because the toggle had zeroed it.
  const changed = lines.filter(isAdjusted).length;
  const unanswered = blockedLines(lines);
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
        stat={
          `${lines.length} ingredients · ${covers} benches` +
          (gfTables || veganTables ? ` · ${gfTables} GF, ${veganTables} vegan` : '') +
          ` · ${changed} adjusted`
        }
      />
      <div className="scroll">
        {error && <ErrorBanner title={error.title} message={error.message} onDismiss={() => setError(null)} />}
        {lines.length === 0 && <div className="empty">No ingredients for that recipe.</div>}
        {lines.map((l, i) => {
          const remaining = l.entryMode === 'REMAINING';
          const qty = displayedQty(l);
          const variance = varianceOf(l);
          const dot = statusOf(l);
          const benches = impliedBenches(l);
          // F-1: ONE mutation path for every stepper, so `+`, `−`, `Bench+`
          // and `Bench−` cannot disagree about direction — they differ only in
          // the size of the step.
          const bump = (by: number) => setLine(i, bumpDisplayed(l, by));
          const benchWord = remaining ? 'bench left' : 'bench';
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
                  onClick={() => setLine(i, toggleMode(l))}
                >
                  {remaining ? "ENTERING: WHAT'S LEFT — tap to switch" : 'ENTERING: AMOUNT USED — tap to switch'}
                </button>
                <div className="hint book">
                  Expected {l.expectedQty} {l.stockUom}
                  {/* What one bench costs, so the Bench± steps are legible and
                      a baker can sanity-check the total in their head. */}
                  {l.qtyPerBench > 0 && (
                    <span className="perTable">
                      {' · '}
                      {l.qtyPerBench} {l.stockUom} per bench
                    </span>
                  )}
                  {variance !== null && variance !== 0 && (
                    <span className="badge warn" style={{ marginLeft: 6 }}>
                      Δ {variance > 0 ? '+' : ''}{variance}
                    </span>
                  )}
                  {remaining && !l.remainingSet && (
                    <span className="badge warn" style={{ marginLeft: 6 }}>not counted yet</span>
                  )}
                  {l.wastageQty > 0 && <span className="badge" style={{ marginLeft: 6 }}>waste {l.wastageQty}{l.wastageReason ? ` · ${l.wastageReason}` : ''}</span>}
                </div>
                {/* F-7: "Request to show benches under the kilo figures."
                    The count under the figure, in the venue's own word — a
                    baker coming back to a half-finished bake can check it
                    against the room without tapping anything.

                    No conversion: a bench IS a table. An earlier reading took
                    them for different units and multiplied by a per-site
                    ratio, which would have rendered "4 of 5 tables · ≈ 24
                    benches" for a five-bench session. */}
                {benches !== null && (
                  <div className="hint benches">
                    {benches} of {covers} bench{covers === 1 ? '' : 'es'}
                  </div>
                )}
              </div>
              <div className="qty-controls">
                <button className="step" aria-label={`Decrease ${l.name}`} onClick={() => bump(-1)}>−</button>
                <button
                  className={`qty-value ${remaining ? 'remaining' : ''}`}
                  aria-label={remaining ? `Type what is left of ${l.name}` : `Type amount of ${l.name} used`}
                  onClick={() => setActualTarget(i)}
                >
                  {qty}
                </button>
                <button className="step" aria-label={`Increase ${l.name}`} onClick={() => bump(1)}>+</button>
                {/* A whole bench's worth in one press. Bakers think in
                    benches, not kilograms. Labelled "+1 bench left" in
                    REMAINING mode so the press cannot be misread (F-1). */}
                <button
                  className="step-table"
                  aria-label={`Remove one ${benchWord} of ${l.name}`}
                  disabled={l.qtyPerBench <= 0}
                  onClick={() => bump(-l.qtyPerBench)}
                >
                  −1 {benchWord}
                </button>
                {/* F-3: the benches-worth of the CURRENT quantity, updating on
                    every press — not the session total, which was identical on
                    every row and unaffected by every button beside it. */}
                <span className="table-count" aria-hidden>
                  {benches === null ? '—' : `${benches} / ${covers}`}
                </span>
                <button
                  className="step-table"
                  aria-label={`Add one ${benchWord} of ${l.name}`}
                  disabled={l.qtyPerBench <= 0}
                  onClick={() => bump(l.qtyPerBench)}
                >
                  +1 {benchWord}
                </button>
                <button className={`zero${l.wastageQty > 0 ? ' on' : ''}`} aria-label="Wastage" onClick={() => setWasteTarget(i)}>⚠</button>
              </div>
            </div>
          );
        })}
      </div>

      <ActionBar>
        <BigButton variant="ok" disabled={!canSubmit} onClick={() => void doSubmit()}>
          {submit.isPending
            ? 'Submitting…'
            : unanswered.length > 0
              ? `${unanswered.length} line${unanswered.length === 1 ? '' : 's'} not counted yet`
              : 'Submit consumption'}
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
          initial={displayedQty(at)}
          onCancel={() => setActualTarget(null)}
          onConfirm={(v) => {
            setLine(actualTarget, setDisplayed(at, v));
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
