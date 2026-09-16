import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
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
  useRecordStockTakeCounts,
  useApproveStockTake,
} from '@/features/pwa/use-pwa-jobs';
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
}

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

  const [scope, setScope] = React.useState('FULL');
  const [takeId, setTakeId] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<TakeLine[]>([]);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
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
    setTakeId(res.data.take.id);
    setLines((res.data.lines as TakeLine[]) ?? []);
    setCounts({});
    setSearch('');
    setFilter('all');
  };

  const setCount = (productId: string, q: number) =>
    setCounts((c) => ({ ...c, [productId]: Math.round(q * 100) / 100 }));

  const submitCounts = async () => {
    if (!takeId) return;
    const counted = lines
      .filter((l) => counts[l.productId] !== undefined)
      .map((l) => {
        const uom = l.stockUom ?? productMap?.get(l.productId)?.stockUom ?? 'each';
        // The quantum is the product's own configured one, or nothing at all.
        // `bucketCount` has no default — a blanket 100 rounded a 4 kg count of
        // icing sugar to 0 and a 250 g count to 300 (defect D-2).
        return {
          productId: l.productId,
          countedQty: bucketCount(counts[l.productId], uom, quantumOf(l)),
        };
      });
    if (counted.length === 0) return;
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
    setTakeId(null);
    setLines([]);
    setCounts({});
  };

  // ── Start screen ──────────────────────────────────────────
  if (!takeId) {
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
            <p className="lede">Count stock against the book figure. Variance is trued up on approval.</p>
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
            <BigButton variant="solid" disabled={!selectedSiteId || open.isPending} onClick={() => void startCount()}>
              {open.isPending ? 'Opening…' : 'Start count'}
            </BigButton>
          </div>
        </div>
      </TouchScreen>
    );
  }

  // ── Count screen ──────────────────────────────────────────
  const countedTotal = lines.filter((l) => counts[l.productId] !== undefined).length;
  const pct = lines.length === 0 ? 0 : Math.round((countedTotal / lines.length) * 100);
  const visible = lines.filter((l) => {
    if (!matchesSearch(l, productMap?.get(l.productId), search)) return false;
    if (filter === 'todo' && counts[l.productId] !== undefined) return false;
    return true;
  });
  // Sections are built from the FILTERED list, so search and "Not counted"
  // narrow what is on screen; their progress counts are the section's own.
  const sections = groupByCategory(visible, (l) => counts[l.productId] !== undefined);
  const anyCollapsed = sections.some((sec) => isCollapsed(collapsed, sec.name));

  const target = typeTarget ? productMap?.get(typeTarget) : undefined;
  const targetLine = typeTarget ? lines.find((l) => l.productId === typeTarget) : undefined;

  return (
    <TouchScreen>
      <TouchTopbar
        title="Stock-take"
        venue={selectedSite?.name ?? null}
        venueBound={isBound}
        sub={scope === 'FULL' ? 'Full' : scope === 'CYCLE' ? 'Cycle' : 'Category'}
        onBack={() => {
          // Uncommitted counts are the ones a Back tap would lose.
          if (Object.keys(counts).length > 0) setConfirmExit(true);
          else setTakeId(null);
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

      <div className="scroll">
        {error && <ErrorBanner title={error.title} message={error.message} onDismiss={() => setError(null)} />}
        {lines.length === 0 && <div className="empty">No stock lines in scope.</div>}
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
          const counted = counts[l.productId] !== undefined;
          const qty = counts[l.productId] ?? 0;
          const variance = counted ? Math.round((qty - book) * 100) / 100 : null;
          const unknown = isUnidentified(l, p);
          const note = bucketNote(quantumOf(l), uom);
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
        <BigButton variant="outline" disabled={record.isPending || countedTotal === 0} onClick={() => void submitCounts()}>
          {record.isPending ? 'Saving…' : 'Save counts'}
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
          message={`You have ${Object.keys(counts).length} count${Object.keys(counts).length === 1 ? '' : 's'} that have not been saved.`}
          discardLabel="Discard them"
          onKeep={() => setConfirmExit(false)}
          onDiscard={() => {
            setConfirmExit(false);
            setCounts({});
            setTakeId(null);
          }}
        />
      )}

      {typeTarget && (
        <KeypadSheet
          title={
            targetLine
              ? takeLineLabel(targetLine, target)
              : (target?.name ?? 'Enter count')
          }
          initial={counts[typeTarget] ?? 0}
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
