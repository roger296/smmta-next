import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, MAX_PAGE_SIZE, type PaginatedResult } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { useRoles } from '@/features/auth/use-roles';
import { bucketCount, bucketNote } from '@/lib/uom';
import { countInstruction } from '@/features/pwa/count-instruction';
import {
  groupByCategory,
  isCollapsed,
  loadCollapsed,
  saveCollapsed,
  toggleCollapsed,
} from '@/features/pwa/count-sections';
import {
  useOpenStockTake,
  useOpenStockTakes,
  useRecordStockTakeCounts,
  useApproveStockTake,
  useStockTake,
  type OpenStockTake,
} from '@/features/pwa/use-pwa-jobs';
import {
  attribution,
  clockTime,
  conflicts,
  countersOn,
  rowCount,
  settleQueued,
  type CountConflict,
  type CountMap,
} from '@/features/pwa/shared-take';
import { currentUserId } from '@/lib/auth';
import type { Product } from '@/lib/api-types';
import { PwaSyncPill } from '@/features/pwa/queue-status';
import {
  TouchScreen,
  TouchTopbar,
  TouchToolbar,
  TouchChip,
  CountRow,
  KeypadSheet,
  BigButton,
  ActionBar,
  ErrorBanner,
  DiscardGuardSheet,
  BottomSheet,
} from '@/components/touch/touch';

export const Route = createFileRoute('/_touch/pwa/stock-take')({
  component: StockTakeScreen,
});

/**
 * A take line as the server now returns it (defect D-1b).
 *
 * The identity fields come down WITH the line, so the count screen never needs
 * a second request to name its own rows. `useProductMap` below stays only as a
 * supplementary lookup for anything the line doesn't carry — it is no longer
 * load-bearing, which is the whole point: on 12 Aug it 400d and took every row
 * label down with it.
 */
interface TakeLine {
  productId: string;
  bookQty: string;
  productName?: string | null;
  stockCode?: string | null;
  stockUom?: string | null;
  itemKind?: string | null;
  /** Per-product counting quantum in the product's own stock UoM. null (the
   *  normal case) means the count is submitted exactly as entered — see D-2. */
  countQuantum?: string | null;
  /** Head office's own wording for this item, if they set one. Comes down on
   *  the line for the same reason the name does — see the comment above. */
  stockCheckInstruction?: string | null;
  /** Item Category, which splits the sheet into sections. Also on the line. */
  itemCategoryName?: string | null;
  /** The SAVED count and whose it is — shared by every counter on the take
   *  (Sept 2026). null until somebody saves this line. */
  countedQty?: string | null;
  countedByUserId?: string | null;
  countedByName?: string | null;
  countedAt?: string | null;
}

interface TakeData {
  take: { id: string; scope?: string; openedByName?: string | null };
  lines: TakeLine[];
}

const SCOPE_LABEL: Record<string, string> = { FULL: 'Full count', CYCLE: 'Cycle count', CATEGORY: 'Category count' };

const SCOPES: Array<{ value: string; label: string }> = [
  { value: 'FULL', label: 'Full count' },
  { value: 'CYCLE', label: 'Cycle count' },
  { value: 'CATEGORY', label: 'Category' },
];

/**
 * Supplementary product lookup. Two things changed after 12 Aug:
 *
 *  - it asks for `MAX_PAGE_SIZE`, not 500. Above the cap the request 400s
 *    outright rather than returning a short page (defect D-1);
 *  - it **pages to completion** instead of assuming one page covers the
 *    catalogue. A venue with more than 250 stocked lines was silently seeing
 *    a partial map even when the request succeeded.
 *
 * It is no longer load-bearing — the row label comes off the line — so a
 * failure here degrades the screen rather than emptying it.
 */
function useProductMap() {
  return useQuery<Map<string, Product>>({
    queryKey: ['pwa-product-map'],
    queryFn: async () => {
      const all: Product[] = [];
      let page = 1;
      // A hard stop, so a server that keeps reporting more pages than it
      // serves cannot spin the venue iPad forever.
      const MAX_PAGES = 40;
      for (; page <= MAX_PAGES; page += 1) {
        const res = await apiFetch<PaginatedResult<Product>>('/products', {
          searchParams: { page, pageSize: MAX_PAGE_SIZE },
        });
        const rows = Array.isArray(res) ? (res as Product[]) : res.data;
        all.push(...rows);
        const totalPages = Array.isArray(res) ? 1 : res.totalPages;
        if (rows.length === 0 || page >= (totalPages || 1)) break;
      }
      return new Map(all.map((p) => [p.id, p]));
    },
    // A missing name is now cosmetic, so don't hammer a failing endpoint from
    // a venue iPad on bad wifi.
    retry: 1,
  });
}

/**
 * What to call this row. The line's own `productName` wins; the product map is
 * a fallback; and when neither knows, we say so **legibly** —
 * "Unknown product (ING-ICING)" — never a bare hex fragment, which is what a
 * counter was handed on 12 Aug (defect D-1).
 */
export function takeLineLabel(line: TakeLine, mapped?: Product): string {
  const name = line.productName ?? mapped?.name;
  if (name) return name;
  const ref = line.stockCode ?? mapped?.stockCode ?? line.productId.slice(0, 8);
  return `Unknown product (${ref})`;
}

/** True when the row has no real identity — drives the warn dot. */
export function isUnidentified(line: TakeLine, mapped?: Product): boolean {
  return !(line.productName ?? mapped?.name);
}

/** The product's configured counting quantum, or null for "do not bucket". */
export function quantumOf(line: TakeLine): number | null {
  if (line.countQuantum == null) return null;
  const n = Number(line.countQuantum);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Search matches the name AND the stock code (defect D-3). */
export function matchesSearch(line: TakeLine, mapped: Product | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    line.productName ?? mapped?.name ?? '',
    line.stockCode ?? mapped?.stockCode ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** Exported so the component tests can render the screen without a router. */
export function StockTakeScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedSite, selectedSiteId, isBound } = useSiteContext();
  const { data: productMap } = useProductMap();
  const open = useOpenStockTake();
  const record = useRecordStockTakeCounts();
  const approve = useApproveStockTake();
  const { toast } = useToast();
  // Approval writes the variance straight into the ledger, so it is
  // site_manager+ (E-4). HIDDEN rather than disabled: a greyed-out button a
  // baker cannot explain is a dead end, which is the complaint this came from.
  const { can } = useRoles();
  const mayApprove = can(['site_manager']);
  // Who "you" is, so your own saved counts say "you" rather than your name.
  const meId = React.useMemo(currentUserId, []);

  const [scope, setScope] = React.useState('FULL');
  const [takeId, setTakeId] = React.useState<string | null>(null);
  // Several counters, one take (Sept 2026). Three sources of a number, never
  // confused (see features/pwa/shared-take.ts): typed here and not yet sent,
  // sent while offline and still queued, and saved on the server by anyone.
  const [pending, setPending] = React.useState<CountMap>({});
  const [queued, setQueued] = React.useState<CountMap>({});
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<'all' | 'todo'>('all');
  // Which category sections this device has folded away. Read once from the
  // device rather than on every render, and written back on every change.
  const [collapsed, setCollapsed] = React.useState<string[]>(() => loadCollapsed());

  function setSectionCollapsed(next: string[]) {
    setCollapsed(next);
    saveCollapsed(next);
  }
  const [typeTarget, setTypeTarget] = React.useState<string | null>(null);
  const [error, setError] = React.useState<{ title: string; message: string } | null>(null);
  // A-5: counts entered but not saved must not disappear on a stray Back.
  const [confirmExit, setConfirmExit] = React.useState(false);
  // Counts about to overwrite a DIFFERENT number someone else saved.
  const [replacing, setReplacing] = React.useState<CountConflict[] | null>(null);

  // The venue's open takes, so a second counter joins rather than starting a
  // parallel count nobody else can see. Only fetched on the start screen.
  const openTakes = useOpenStockTakes(selectedSiteId, !takeId);
  // The take itself, re-read on a timer so each counter sees the others' saves.
  const takeQuery = useStockTake<TakeData>(takeId);
  const lines = React.useMemo(() => takeQuery.data?.lines ?? [], [takeQuery.data]);

  // Queued counts that the server now shows as saved by me move from
  // "Waiting to send" to "Saved by you".
  React.useEffect(() => {
    setQueued((q) => settleQueued(q, lines, meId));
  }, [lines, meId]);

  const leaveTake = () => {
    setTakeId(null);
    setPending({});
    setQueued({});
    setSearch('');
    setFilter('all');
    void queryClient.invalidateQueries({ queryKey: ['stock-takes', 'open'] });
  };

  const startCount = async () => {
    if (!selectedSiteId) return;
    setError(null);
    let res;
    try {
      res = await open.mutateAsync({ siteId: selectedSiteId, scope });
    } catch (err) {
      setError({
        title: 'Could not open a stock-take',
        message: err instanceof Error ? err.message : 'The request failed. Try again.',
      });
      return;
    }
    // Hand the screen the lines we were just given rather than fetching them
    // again; the poll takes over from here.
    queryClient.setQueryData<TakeData>(['stock-take', res.data.take.id], {
      take: res.data.take,
      lines: (res.data.lines as TakeLine[]) ?? [],
    });
    setPending({});
    setQueued({});
    setSearch('');
    setFilter('all');
    setTakeId(res.data.take.id);
  };

  const joinTake = (t: OpenStockTake) => {
    setError(null);
    setPending({});
    setQueued({});
    setSearch('');
    setFilter('all');
    setTakeId(t.id);
  };

  const setCount = (productId: string, q: number) =>
    setPending((c) => ({ ...c, [productId]: Math.round(q * 100) / 100 }));

  /** The counts this iPad would send, bucketed as they will be saved. */
  const outgoing = () =>
    lines
      .filter((l) => pending[l.productId] !== undefined)
      .map((l) => {
        const uom = l.stockUom ?? productMap?.get(l.productId)?.stockUom ?? 'each';
        // The quantum is the product's own configured one, or nothing at all.
        // `bucketCount` has no default — a blanket 100 rounded a 4 kg count of
        // icing sugar to 0 and a 250 g count to 300 (defect D-2).
        return {
          productId: l.productId,
          countedQty: bucketCount(pending[l.productId]!, uom, quantumOf(l)),
        };
      });

  const submitCounts = async (replaceConfirmed = false) => {
    if (!takeId) return;
    const counted = outgoing();
    if (counted.length === 0) return;
    // What was typed when Save was pressed, to tell a later edit from this one.
    const typedAtSave = { ...pending };
    // Saving is last-writer-wins per line. Before overwriting a different
    // number somebody else saved, say whose and ask.
    if (!replaceConfirmed) {
      const clash = conflicts(
        lines,
        Object.fromEntries(counted.map((c) => [c.productId, c.countedQty])),
        meId,
      );
      if (clash.length > 0) {
        setReplacing(clash);
        return;
      }
    }
    setReplacing(null);
    setError(null);
    let res;
    try {
      res = await record.mutateAsync({ stockTakeId: takeId, counts: counted });
    } catch (err) {
      setError({
        title: 'Counts not saved',
        message: err instanceof Error ? err.message : 'Something went wrong. Your counts are still here.',
      });
      return;
    }
    if (res.status === 'rejected') {
      // Refused by the server, so nothing was queued and nothing is cleared:
      // the counts stay on screen (defect A-1).
      setError({
        title: 'Counts not saved — the server refused them',
        message: res.error?.message ?? 'The counts were rejected. They are still on this screen.',
      });
      return;
    }
    const sent = new Map(counted.map((c) => [c.productId, c.countedQty]));
    // Clear only what was sent. A number retyped while the save was in flight
    // is newer than the one that went, so it stays pending.
    setPending((p) => {
      const next: CountMap = {};
      for (const [id, qty] of Object.entries(p)) {
        if (!sent.has(id) || qty !== typedAtSave[id]) next[id] = qty;
      }
      return next;
    });
    if (res.status === 'queued') {
      // Not on the server yet, so nobody else can see these — keep them on
      // this screen, labelled as waiting, until the queue delivers them.
      setQueued((q) => ({ ...q, ...Object.fromEntries(sent) }));
    }
    void queryClient.invalidateQueries({ queryKey: ['stock-take', takeId] });
    toast({ title: res.status === 'sent' ? 'Counts saved' : 'Saved offline — will sync' });
  };

  const approveTake = async () => {
    if (!takeId) return;
    setError(null);
    try {
      await approve.mutateAsync(takeId);
    } catch (err) {
      setError({
        title: 'Not approved',
        message: err instanceof Error ? err.message : 'The approval failed. Your counts are still here.',
      });
      return;
    }
    toast({ title: 'Stock-take approved — ledger trued up' });
    leaveTake();
  };

  // ── Start screen ──────────────────────────────────────────
  if (!takeId) {
    const inProgress = openTakes.data ?? [];
    return (
      <TouchScreen>
        <TouchTopbar
          title="Stock-take"
          venue={selectedSite?.name ?? null}
        venueBound={isBound}
          onBack={() => void navigate({ to: '/' })}
        />
        <div className="scroll">
          {error && <ErrorBanner title={error.title} message={error.message} onDismiss={() => setError(null)} />}
          <div className="center">
            <h1>{selectedSite?.name ?? 'Select a site'}</h1>
            {inProgress.length > 0 && (
              <div className="field" data-testid="open-takes">
                {/* Joining is the default when a count is already running:
                    two people starting two takes would each count into one
                    the other can never see. */}
                <label>Count in progress — join it to count together</label>
                {inProgress.map((t) => (
                  <div key={t.id} className="join-take">
                    <div className="join-take-meta">
                      <strong>{SCOPE_LABEL[t.scope] ?? 'Count'}</strong>
                      {' · started '}
                      {clockTime(t.createdAt) || 'earlier'}
                      {t.openedByName ? ` by ${t.openedByName}` : ''}
                      <div className="join-take-progress">
                        {t.countedCount} of {t.lineCount} counted
                        {t.counters.length > 0 ? ` by ${t.counters.join(', ')}` : ''}
                      </div>
                    </div>
                    <BigButton variant="solid" onClick={() => joinTake(t)}>
                      Join this count
                    </BigButton>
                  </div>
                ))}
              </div>
            )}
            <p className="lede">
              {inProgress.length > 0
                ? 'Or start a separate count:'
                : 'Count stock against the book figure. Variance is trued up on approval.'}
            </p>
            <div className="field">
              <label>What are you counting?</label>
              <div className="tile-grid">
                {SCOPES.map((s) => (
                  <button
                    key={s.value}
                    className={`tile${scope === s.value ? ' on' : ''}`}
                    onClick={() => setScope(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <BigButton
              variant={inProgress.length > 0 ? 'outline' : 'solid'}
              disabled={!selectedSiteId || open.isPending}
              onClick={() => void startCount()}
            >
              {open.isPending ? 'Opening…' : inProgress.length > 0 ? 'Start a new count' : 'Start count'}
            </BigButton>
          </div>
        </div>
      </TouchScreen>
    );
  }

  // ── Count screen ──────────────────────────────────────────
  const rows = new Map(lines.map((l) => [l.productId, rowCount(l, pending, queued, meId)]));
  const rowOf = (l: TakeLine) => rows.get(l.productId)!;
  const pendingCount = Object.keys(pending).length;
  const countedTotal = lines.filter((l) => rowOf(l).counted).length;
  const pct = lines.length === 0 ? 0 : Math.round((countedTotal / lines.length) * 100);
  const visible = lines.filter((l) => {
    if (!matchesSearch(l, productMap?.get(l.productId), search)) return false;
    if (filter === 'todo' && rowOf(l).counted) return false;
    return true;
  });
  // Sections are built from the FILTERED list, so search and "Not counted"
  // narrow what is on screen; their progress counts are the section's own.
  const sections = groupByCategory(visible, (l) => rowOf(l).counted);
  const anyCollapsed = sections.some((sec) => isCollapsed(collapsed, sec.name));
  const counters = countersOn(lines, meId);
  const takeScope = takeQuery.data?.take.scope ?? scope;

  const target = typeTarget ? productMap?.get(typeTarget) : undefined;
  const targetLine = typeTarget ? lines.find((l) => l.productId === typeTarget) : undefined;

  return (
    <TouchScreen>
      <TouchTopbar
        title="Stock-take"
        venue={selectedSite?.name ?? null}
        venueBound={isBound}
        sub={takeScope === 'FULL' ? 'Full' : takeScope === 'CYCLE' ? 'Cycle' : 'Category'}
        onBack={() => {
          // Uncommitted counts are the ones a Back tap would lose.
          if (pendingCount > 0) setConfirmExit(true);
          else leaveTake();
        }}
        right={<PwaSyncPill />}
        stat={`${countedTotal} / ${lines.length} counted`}
        progress={pct}
      />
      <TouchToolbar search={search} onSearch={setSearch} placeholder="Search items…">
        <TouchChip on={filter === 'all'} onClick={() => setFilter('all')}>All</TouchChip>
        <TouchChip on={filter === 'todo'} onClick={() => setFilter('todo')}>Not counted</TouchChip>
        {/* One tap back to the whole sheet. Without it, un-hiding four
            sections is four taps and the counter has to remember which. */}
        {anyCollapsed && (
          <TouchChip on={false} onClick={() => setSectionCollapsed([])}>
            Show all sections
          </TouchChip>
        )}
      </TouchToolbar>

      {/* Who else is on this count, and how fresh this screen's copy is. */}
      <div className="shared-take-note" data-testid="shared-take-note">
        {counters.length > 0
          ? `Saved counts: ${counters.map((c) => `${c.name} (${c.lines})`).join(' · ')}`
          : 'No counts saved yet.'}
        {takeQuery.dataUpdatedAt > 0 && (
          <span className="shared-take-fresh">
            {takeQuery.isError
              ? ` · could not refresh — showing counts from ${clockTime(new Date(takeQuery.dataUpdatedAt).toISOString())}`
              : ` · updated ${clockTime(new Date(takeQuery.dataUpdatedAt).toISOString())}`}
          </span>
        )}
      </div>

      <div className="scroll">
        {error && <ErrorBanner title={error.title} message={error.message} onDismiss={() => setError(null)} />}
        {!takeQuery.data && takeQuery.isLoading && <div className="empty">Loading the count…</div>}
        {!takeQuery.data && takeQuery.isError && (
          <div className="empty">Could not load this count. Go back and try again.</div>
        )}
        {takeQuery.data && lines.length === 0 && <div className="empty">No stock lines in scope.</div>}
        {lines.length > 0 && visible.length === 0 && <div className="empty">Nothing matches.</div>}
        {sections.map((section) => {
          const folded = isCollapsed(collapsed, section.name);
          return (
            <section key={section.name} className="count-section">
              {/* The whole header is the control: a 46px-plus target that a
                  counter can hit without looking, rather than a small chevron. */}
              <button
                type="button"
                className="count-section-head"
                aria-expanded={!folded}
                onClick={() => setSectionCollapsed(toggleCollapsed(collapsed, section.name))}
              >
                <span className="count-section-chevron" aria-hidden="true">
                  {folded ? '▸' : '▾'}
                </span>
                <span className="count-section-name">{section.name}</span>
                {/* Progress stays visible when the section is folded — hiding
                    a section for clarity must not hide that it is unfinished. */}
                <span className="count-section-progress">
                  {section.counted} / {section.total}
                </span>
                <span className="count-section-action">{folded ? 'Show' : 'Hide'}</span>
              </button>
              {!folded && section.lines.map((l) => {
          const p = productMap?.get(l.productId);
          const uom = l.stockUom ?? p?.stockUom ?? '';
          const book = Number(l.bookQty);
          const row = rowOf(l);
          const counted = row.counted;
          const qty = row.qty;
          const variance = counted ? Math.round((qty - book) * 100) / 100 : null;
          const unknown = isUnidentified(l, p);
          const note = bucketNote(quantumOf(l), uom);
          const who = attribution(row);
          return (
            <CountRow
              key={l.productId}
              name={takeLineLabel(l, p)}
              // What to do with this item, in place of the old "Book: N uom".
              // The book figure is deliberately NOT shown before the count: a
              // counter who can see the expected answer has been told it, and a
              // count that agrees with the ledger proves nothing. It reappears
              // as the variance badge the moment a number is entered, which is
              // when the comparison is worth something.
              instruction={countInstruction(
                l.stockCheckInstruction ?? p?.stockCheckInstruction,
                uom,
              )}
              hint={
                <>
                  {l.stockCode}
                  {/* If a count IS bucketed, say so on the row — a counter
                      should see what happened to their number here, not
                      discover it later on the variance report. */}
                  {note && <span className="badge" style={{ marginLeft: 6 }}>{note}</span>}
                  {/* Whose number this is: yours, a colleague's, or not sent. */}
                  {who && (
                    <span className={`counted-by counted-by-${row.source}${row.mine ? ' mine' : ''}`}>
                      {who}
                    </span>
                  )}
                </>
              }
              counted={counted}
              qty={qty}
              status={unknown ? 'warn' : !counted ? 'todo' : variance === 0 ? 'done' : 'warn'}
              badge={
                variance !== null && variance !== 0 ? (
                  <span className="badge warn">Δ {variance > 0 ? '+' : ''}{variance}</span>
                ) : undefined
              }
              onSet={(newQty) => setCount(l.productId, newQty)}
              onType={() => setTypeTarget(l.productId)}
            />
          );
        })}
            </section>
          );
        })}
      </div>

      <ActionBar>
        <BigButton variant="outline" disabled={record.isPending || pendingCount === 0} onClick={() => void submitCounts()}>
          {record.isPending ? 'Saving…' : pendingCount > 0 ? `Save counts (${pendingCount})` : 'Save counts'}
        </BigButton>
        {mayApprove && (
          <BigButton variant="ok" disabled={approve.isPending} onClick={() => void approveTake()}>
            {approve.isPending ? 'Approving…' : 'Approve & true-up'}
          </BigButton>
        )}
      </ActionBar>

      {confirmExit && (
        <DiscardGuardSheet
          title="Leave the count?"
          message={`You have ${pendingCount} count${pendingCount === 1 ? '' : 's'} that have not been saved.`}
          discardLabel="Discard them"
          onKeep={() => setConfirmExit(false)}
          onDiscard={() => {
            setConfirmExit(false);
            leaveTake();
          }}
        />
      )}

      {replacing && (
        <BottomSheet title="Replace someone else's count?" onClose={() => setReplacing(null)}>
          <p className="lede">
            {replacing.length === 1
              ? 'This item was already counted by someone else. Saving replaces their number with yours:'
              : `${replacing.length} items were already counted by someone else. Saving replaces their numbers with yours:`}
          </p>
          <ul className="replace-list">
            {replacing.map((c) => {
              const l = lines.find((x) => x.productId === c.productId);
              const uom = l?.stockUom ?? '';
              return (
                <li key={c.productId}>
                  <strong>{l ? takeLineLabel(l, productMap?.get(c.productId)) : c.productId}</strong>
                  {` — ${c.theirName} counted ${c.theirQty} ${uom}, you have ${c.yourQty} ${uom}`}
                </li>
              );
            })}
          </ul>
          <div className="sheet-actions">
            {/* Going back is the SOLID one — the safe choice first. */}
            <BigButton variant="solid" onClick={() => setReplacing(null)}>Go back and check</BigButton>
            <BigButton variant="ghost" onClick={() => void submitCounts(true)}>Replace with mine</BigButton>
          </div>
        </BottomSheet>
      )}

      {typeTarget && (
        <KeypadSheet
          title={
            targetLine
              ? takeLineLabel(targetLine, target)
              : (target?.name ?? 'Enter count')
          }
          initial={targetLine ? rowOf(targetLine).qty : 0}
          onCancel={() => setTypeTarget(null)}
          onConfirm={(v) => {
            setCount(typeTarget, v);
            setTypeTarget(null);
          }}
        />
      )}
    </TouchScreen>
  );
}
