import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, type PaginatedResult } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { bucketCount } from '@/lib/uom';
import {
  useOpenStockTake,
  useRecordStockTakeCounts,
  useApproveStockTake,
} from '@/features/pwa/use-pwa-jobs';
import type { Product } from '@/lib/api-types';
import {
  TouchScreen,
  TouchTopbar,
  TouchToolbar,
  TouchChip,
  CountRow,
  KeypadSheet,
  BigButton,
  ActionBar,
  SyncPill,
} from '@/components/touch/touch';

export const Route = createFileRoute('/_authed/pwa/stock-take')({
  component: StockTakeScreen,
});

interface TakeLine {
  productId: string;
  bookQty: string;
}

const SCOPES: Array<{ value: string; label: string }> = [
  { value: 'FULL', label: 'Full count' },
  { value: 'CYCLE', label: 'Cycle count' },
  { value: 'CATEGORY', label: 'Category' },
];

function useProductMap() {
  return useQuery<Map<string, Product>>({
    queryKey: ['pwa-product-map'],
    queryFn: async () => {
      const res = await apiFetch<PaginatedResult<Product>>('/products', { searchParams: { pageSize: 500 } });
      const rows = Array.isArray(res) ? (res as Product[]) : res.data;
      return new Map(rows.map((p) => [p.id, p]));
    },
  });
}

function StockTakeScreen() {
  const navigate = useNavigate();
  const { selectedSite, selectedSiteId } = useSiteContext();
  const { data: productMap } = useProductMap();
  const open = useOpenStockTake();
  const record = useRecordStockTakeCounts();
  const approve = useApproveStockTake();
  const { toast } = useToast();

  const [scope, setScope] = React.useState('FULL');
  const [takeId, setTakeId] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<TakeLine[]>([]);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<'all' | 'todo'>('all');
  const [typeTarget, setTypeTarget] = React.useState<string | null>(null);

  const startCount = async () => {
    if (!selectedSiteId) return;
    const res = await open.mutateAsync({ siteId: selectedSiteId, scope });
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
        const uom = productMap?.get(l.productId)?.stockUom ?? 'each';
        return { productId: l.productId, countedQty: bucketCount(counts[l.productId], uom) };
      });
    if (counted.length === 0) return;
    const res = await record.mutateAsync({ stockTakeId: takeId, counts: counted });
    toast({ title: res.status === 'sent' ? 'Counts saved' : 'Saved offline — will sync' });
  };

  const approveTake = async () => {
    if (!takeId) return;
    await approve.mutateAsync(takeId);
    toast({ title: 'Stock-take approved — ledger trued up' });
    setTakeId(null);
    setLines([]);
    setCounts({});
  };

  // ── Start screen ──────────────────────────────────────────
  if (!takeId) {
    return (
      <TouchScreen>
        <TouchTopbar title="Stock-take" onBack={() => void navigate({ to: '/' })} />
        <div className="scroll">
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
  const q = search.trim().toLowerCase();
  const visible = lines.filter((l) => {
    const p = productMap?.get(l.productId);
    const name = p?.name ?? l.productId;
    if (q && !name.toLowerCase().includes(q)) return false;
    if (filter === 'todo' && counts[l.productId] !== undefined) return false;
    return true;
  });
  const target = typeTarget ? productMap?.get(typeTarget) : undefined;

  return (
    <TouchScreen>
      <TouchTopbar
        title={selectedSite?.name ?? 'Stock-take'}
        sub={scope === 'FULL' ? 'Full' : scope === 'CYCLE' ? 'Cycle' : 'Category'}
        onBack={() => setTakeId(null)}
        right={<SyncPill state={record.isPending ? 'syncing' : 'synced'} />}
        stat={`${countedTotal} / ${lines.length} counted`}
        progress={pct}
      />
      <TouchToolbar search={search} onSearch={setSearch} placeholder="Search items…">
        <TouchChip on={filter === 'all'} onClick={() => setFilter('all')}>All</TouchChip>
        <TouchChip on={filter === 'todo'} onClick={() => setFilter('todo')}>Not counted</TouchChip>
      </TouchToolbar>

      <div className="scroll">
        {lines.length === 0 && <div className="empty">No stock lines in scope.</div>}
        {lines.length > 0 && visible.length === 0 && <div className="empty">Nothing matches.</div>}
        {visible.map((l) => {
          const p = productMap?.get(l.productId);
          const uom = p?.stockUom ?? '';
          const book = Number(l.bookQty);
          const counted = counts[l.productId] !== undefined;
          const qty = counts[l.productId] ?? 0;
          const variance = counted ? Math.round((qty - book) * 100) / 100 : null;
          return (
            <CountRow
              key={l.productId}
              name={p?.name ?? l.productId.slice(0, 8)}
              hint={<>Book: {book} {uom}</>}
              counted={counted}
              qty={qty}
              status={!counted ? 'todo' : variance === 0 ? 'done' : 'warn'}
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
      </div>

      <ActionBar>
        <BigButton variant="outline" disabled={record.isPending || countedTotal === 0} onClick={() => void submitCounts()}>
          {record.isPending ? 'Saving…' : 'Save counts'}
        </BigButton>
        <BigButton variant="ok" disabled={approve.isPending} onClick={() => void approveTake()}>
          {approve.isPending ? 'Approving…' : 'Approve & true-up'}
        </BigButton>
      </ActionBar>

      {typeTarget && (
        <KeypadSheet
          title={target?.name ?? 'Enter count'}
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
