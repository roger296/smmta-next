import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { useBakes, groupBakes } from '@/features/recipes/use-recipes';
import {
  describeSession,
  useDietaryCoverage,
  useExpectedConsumption,
  useSessionsAwaiting,
  type AwaitingSession,
  type ExpectedBlocker,
  type SessionFeedStatus,
} from '@/features/consumption/use-consumption';
import { useSubmitConsumption } from '@/features/pwa/use-pwa-jobs';
import {
  blockedLines,
  bumpDisplayed,
  displayedQty,
  impliedBenches,
  isAdjusted,
  lineKey,
  setDisplayed,
  statusOf,
  toggleMode,
  varianceOf,
  type ConsumptionLine,
} from '@/features/consumption/line-reducers';
import { SECTION_LABELS } from '@/features/consumption/use-consumption';
import {
  missingForLoad,
  missingForSubmit,
  refusalLabel,
  type SetupAnswers,
} from '@/features/consumption/form-readiness';
import { PwaSyncPill } from '@/features/pwa/queue-status';
import {
  TouchScreen,
  TouchTopbar,
  KeypadSheet,
  BigButton,
  ActionBar,
  ErrorBanner,
  BlockingNotice,
  DiscardGuardSheet,
  selectOnFocus,
} from '@/components/touch/touch';

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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Exported so the component tests can render the screen without a router. */
export function ConsumptionScreen() {
  const navigate = useNavigate();
  const { selectedSite, selectedSiteId, isBound } = useSiteContext();
  // Active cakes only (item 3) — the picker shows tonight's menu, not every
  // cake ever costed. Grouped Corporate / Regular / Other (item 2).
  const { data: bakes } = useBakes();
  const bakeGroups = React.useMemo(() => groupBakes(bakes), [bakes]);
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
  // The day's sittings at this venue that have no record yet (item 8
  // follow-up). Re-queried when the date changes — a baker filing yesterday's
  // bake this morning needs yesterday's list.
  const awaiting = useSessionsAwaiting(selectedSiteId ?? undefined, sessionDate);
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
        // Items 5 and 6: the product alone is no longer the line's identity.
        section: r.section,
        component: r.component,
        sectionBenches: r.benches,
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


  // Item 8 (Sept-2026): the setup answers, in one shape, so the two buttons
  // below cannot disagree about what is required. They used to: submit needed
  // a session id and a baker name, loading did not, and the gap between them
  // was a baker filling in a whole ingredient list behind a dead button.
  const answers: SetupAnswers = {
    siteId: selectedSiteId ?? null,
    bake,
    regularBenches: regularTables,
    totalBenches: covers,
    sessionId,
    bakerName,
  };
  const missingToLoad = missingForLoad(answers);
  // F-8's guard: a REMAINING line with no figure would be sent as
  // `remainingQty: 0` — "the shelf is empty" — which is a very different claim
  // from "I haven't counted it".
  const missingToSubmit = missingForSubmit(answers, {
    lines: lines.length,
    uncounted: blockedLines(lines).length,
  });
  const canSubmit = missingToSubmit.length === 0 && !submit.isPending;

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
          section: l.section,
          component: l.component,
          entryMode: l.entryMode,
          actualQty: l.actualQty,
          remainingQty: l.remainingQty,
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

            {/* Item 2: "separate bakes into three groups 'Corporate',
                'Regular' and 'Other' with headers". Fixed order, so the
                heading a baker is looking for is in the same place every
                session; an empty group is dropped rather than left as a
                heading with nothing under it. */}
            <div className="field">
              <label>Cake baked</label>
              {bakeGroups.length === 0 ? (
                <p className="field-note blocked">
                  No active cakes for this venue. Head office sets which cakes are on the menu.
                </p>
              ) : (
                bakeGroups.map((group) => (
                  <div className="tile-group" key={group.type}>
                    <h2 className="tile-group-head">{group.label}</h2>
                    <div className="tile-grid">
                      {group.bakes.map((b) => (
                        <button
                          key={b.bake}
                          className={`tile${bake === b.bake ? ' on' : ''}`}
                          onClick={() => setBake(b.bake)}
                        >
                          {b.bake}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
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

            {/* Item 8 follow-up (Sept-2026): the field that caused the defect.
                It was a free-text box captioned "BumbleBee session id" — not a
                thing anybody in a venue knows — so it got skipped, and a
                skipped session id was what left the Submit button dead.
                Guarding it was the fix; REMOVING it is the better one, so the
                day's sittings are offered instead.

                Typing stays reachable throughout. The feed is not wired in
                production yet, and a picker that can only ever be empty would
                be a worse dead end than the box it replaced. */}
            <div className="field">
              <label id="lbl-session">Which session?</label>
              <SessionPicker
                sessions={awaiting.data?.sessions ?? []}
                feedStatus={awaiting.data?.feedStatus}
                isPending={awaiting.isPending}
                failed={awaiting.isError}
                value={sessionId}
                onChange={setSessionId}
              />
            </div>

            <div className="field">
              <label htmlFor="bake-baker-name">Your name (who baked this)</label>
              <input id="bake-baker-name" className="input" value={bakerName} onChange={(e) => setBakerName(e.target.value)} onFocus={selectOnFocus} placeholder="Baker name" autoCapitalize="words" />
            </div>

            <BigButton
              variant="solid"
              disabled={missingToLoad.length > 0 || expected.isPending}
              onClick={() => void loadExpected()}
            >
              {expected.isPending
                ? 'Loading…'
                : refusalLabel(missingToLoad, 'Load ingredients →')}
            </BigButton>
            {/* Item 8: a refusing button has to say what it is waiting for.
                The label names the first missing answer; anything else still
                outstanding is listed here, so a baker can see the whole of
                what is left rather than discovering it one press at a time. */}
            {missingToLoad.length > 1 && (
              <p className="field-note" role="status">
                Also needed: {missingToLoad.slice(1).join(', ')}.
              </p>
            )}
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
  // Only head the list when there is more than one section to tell apart.
  const showSectionHeads = new Set(lines.map((l) => l.section)).size > 1;
  const at = actualTarget !== null ? lines[actualTarget] : undefined;

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
        {/* Item 5: "please split the different recipe sections into separate
            sections with headers. Even though this will result in multiple
            lines for the same product." Each section carries the FULL list its
            benches use — a baker on a vegan bench reads their whole list here
            rather than applying swaps in their head. The heading is dropped
            when there is only one section, because a lone "Regular" header
            above every ingredient is noise. */}
        {lines.map((l, i) => {
          const sectionStart =
            showSectionHeads && (i === 0 || lines[i - 1]!.section !== l.section);
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
            <React.Fragment key={lineKey(l)}>
            {sectionStart && (
              <h2 className="section-head">
                {SECTION_LABELS[l.section]}
                <span className="section-benches">
                  {' · '}
                  {l.sectionBenches} bench{l.sectionBenches === 1 ? '' : 'es'}
                </span>
              </h2>
            )}
            <div className={`row mode-${remaining ? 'remaining' : 'consumed'}`}>
              <div className={`status status-${dot}`} aria-hidden="true">{dot === 'done' ? '●' : '!'}</div>
              <div className="meta">
                <div className="name">
                  {l.name}
                  {/* Item 6: which part of the cake, so two icing-sugar lines
                      are told apart at a glance rather than by position. */}
                  {l.component && <span className="component">{l.component}</span>}
                </div>
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
                    {benches} of {l.sectionBenches} bench{l.sectionBenches === 1 ? '' : 'es'}
                  </div>
                )}
              </div>
              <div className="qty-controls">
                {/* Sept-2026 item 4: two distinct zones, because bakers think
                    in benches, not grams. "the 'bench + and - buttons' … and
                    the count of the number of recipe quanta used are more
                    important to them than the number of grams". The bench zone
                    on the right is scaled 20% above the gram editor on the
                    left — see `--bench-scale` in pwa-touch.css. */}
                <div className="qty-edit">
                  <button className="step" aria-label={`Decrease ${l.name}`} onClick={() => bump(-1)}>−</button>
                  <button
                    className={`qty-value ${remaining ? 'remaining' : ''}`}
                    aria-label={remaining ? `Type what is left of ${l.name}` : `Type amount of ${l.name} used`}
                    onClick={() => setActualTarget(i)}
                  >
                    {qty}
                  </button>
                  <button className="step" aria-label={`Increase ${l.name}`} onClick={() => bump(1)}>+</button>
                </div>
                <div className="bench-controls">
                  {/* A whole bench's worth in one press. Labelled "+1 bench
                      left" in REMAINING mode so the press cannot be misread
                      (F-1). Red for the one that takes a bench away, green for
                      the one that adds it (item 4b). */}
                  <button
                    className="step-table bench-down"
                    aria-label={`Remove one ${benchWord} of ${l.name}`}
                    disabled={l.qtyPerBench <= 0}
                    onClick={() => bump(-l.qtyPerBench)}
                  >
                    −1 {benchWord}
                  </button>
                  {/* F-3: the benches-worth of the CURRENT quantity, updating on
                      every press — not the session total, which was identical on
                      every row and unaffected by every button beside it.
                      Bold and near-black (item 4c): it is the figure the baker
                      is actually working to. */}
                  <span className="table-count" aria-hidden>
                    {benches === null ? '—' : `${benches} / ${l.sectionBenches}`}
                  </span>
                  <button
                    className="step-table bench-up"
                    aria-label={`Add one ${benchWord} of ${l.name}`}
                    disabled={l.qtyPerBench <= 0}
                    onClick={() => bump(l.qtyPerBench)}
                  >
                    +1 {benchWord}
                  </button>
                </div>
              </div>
            </div>
            </React.Fragment>
          );
        })}
      </div>

      <ActionBar>
        <BigButton variant="ok" disabled={!canSubmit} onClick={() => void doSubmit()}>
          {submit.isPending
            ? 'Submitting…'
            : refusalLabel(missingToSubmit, 'Submit consumption')}
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

    </TouchScreen>
  );
}

/**
 * Pick the sitting being filed (Sept-2026 user testing, item 8 follow-up).
 *
 * ── WHY THIS REPLACED A TEXT BOX ────────────────────────────────────────────
 * The Submit button reported as "not working at all" was disabled because the
 * Session ID was blank. The field was captioned "BumbleBee session id" — not
 * something anybody in a venue knows — and sat below the fold, so it got
 * skipped. Making the refusal explain itself fixed the symptom; offering the
 * day's sittings removes the question.
 *
 * ── WHY TYPING IS STILL HERE ────────────────────────────────────────────────
 * BumbleBee session polling is NOT wired in production. `feedStatus` says so,
 * and when it does this renders the manual field with an explanation rather
 * than an empty list. A picker that can only ever be empty would be a worse
 * dead end than the box it replaced: at least a baker could get past that one.
 *
 * The same escape covers the cases a live feed still misses — a sitting added
 * after the poll, a walk-in, a venue iPad with no signal.
 */
function SessionPicker({
  sessions,
  feedStatus,
  isPending,
  failed,
  value,
  onChange,
}: {
  sessions: AwaitingSession[];
  feedStatus: SessionFeedStatus | undefined;
  isPending: boolean;
  failed: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  // Typing is forced open when there is nothing to choose from, and stays open
  // once the baker has asked for it — collapsing it under them mid-type would
  // discard what they had entered.
  const nothingToOffer = sessions.length === 0;
  const [typing, setTyping] = React.useState(false);
  const manual = typing || nothingToOffer;
  // A typed id that matches nothing on the list still counts as chosen.
  const chosen = sessions.find((s) => s.sessionId === value);

  if (isPending && !nothingToOffer) {
    return <p className="field-note">Looking up today's sessions…</p>;
  }

  return (
    <>
      {sessions.length > 0 && (
        <div className="tile-grid" role="group" aria-labelledby="lbl-session">
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              className={`tile${value === s.sessionId ? ' on' : ''}`}
              onClick={() => onChange(s.sessionId)}
            >
              {describeSession(s)}
            </button>
          ))}
        </div>
      )}

      {/* Say WHY the list is empty. "Nothing here" with no reason is the
          failure mode this whole feedback round has been about. */}
      {nothingToOffer && !isPending && (
        <p className="field-note">
          {failed
            ? 'Could not reach the server for today’s sessions — type the session below.'
            : feedStatus === 'not_connected'
              ? 'Session details do not come across from BumbleBee yet, so type the session below.'
              : 'No sessions are outstanding for this venue and date — type the session below.'}
        </p>
      )}

      {!manual && (
        <button type="button" className="linklike" onClick={() => setTyping(true)}>
          My session isn’t listed — type it instead
        </button>
      )}

      {manual && (
        <>
          <input
            id="bake-session-id"
            className="input"
            style={{ marginTop: 8 }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={selectOnFocus}
            placeholder="Session ID"
            aria-label="Session ID"
          />
          {sessions.length > 0 && (
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setTyping(false);
                onChange('');
              }}
            >
              Choose from the list instead
            </button>
          )}
        </>
      )}

      {chosen && (
        <p className="field-note">Filing the {describeSession(chosen)} session.</p>
      )}
    </>
  );
}
