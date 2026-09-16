import * as React from 'react';
import { formatQtyUom, uomFullName, uomFullNameSingular } from '@/lib/uom';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, type PaginatedResult } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useSiteContext } from '@/features/sites/site-context';
import { resolveBarcodeToProduct } from '@/lib/barcode';
import {
  useRecentWastage,
  useRecordWastage,
  WASTAGE_REASONS,
} from '@/features/wastage/use-wastage';
import { PwaSyncPill } from '@/features/pwa/queue-status';
import type { Product } from '@/lib/api-types';
import {
  TouchScreen,
  TouchTopbar,
  TouchToolbar,
  KeypadSheet,
  BigButton,
  ActionBar,
  ErrorBanner,
  selectOnFocus,
} from '@/components/touch/touch';

export const Route = createFileRoute('/_touch/pwa/wastage')({
  component: WastageScreen,
});

/**
 * The Wastage screen (Sept-2026 user testing, item 7).
 *
 * "We currently have a function to add wastage to each line of the recipe in
 *  the end of bake form by clicking the triangles to the right of each line,
 *  please take this wastage function out of the end of bake form and create a
 *  separate Wastage form linked to by a new main menu item on the PWA where any
 *  items from stock can be marked as wasted."
 *
 * The triangle decided three things nobody chose: waste could only be recorded
 * against an ingredient the recipe expected, only during a bake, and only by
 * whoever was filing that bake. A dropped case of eggs on a Tuesday morning had
 * nowhere to go — so it went unrecorded, and turned up later as a variance
 * somebody had to explain.
 *
 * Any stocked item, any time. The bake link stays available but optional:
 * making every dropped delivery box answer "which bake?" would add a step to
 * the commonest case.
 */
export function WastageScreen() {
  const navigate = useNavigate();
  const { selectedSite, selectedSiteId, isBound } = useSiteContext();
  const record = useRecordWastage();
  const recent = useRecentWastage(selectedSiteId);
  const { toast } = useToast();

  const [search, setSearch] = React.useState('');
  const [picked, setPicked] = React.useState<Product | null>(null);
  const [qty, setQty] = React.useState<number | null>(null);
  const [qtyOpen, setQtyOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [note, setNote] = React.useState('');
  const [bakerName, setBakerName] = React.useState('');
  const [error, setError] = React.useState<{ title: string; message: string } | null>(null);

  // Stocked items only — you cannot waste a service or an experience package.
  const results = useQuery<Product[]>({
    queryKey: ['wastage-search', search],
    queryFn: async () => {
      const res = await apiFetch<PaginatedResult<Product>>('/products', {
        searchParams: { search, pageSize: 25, page: 1 },
      });
      return Array.isArray(res) ? (res as Product[]) : res.data;
    },
    enabled: search.trim().length >= 2,
  });

  /** A scanned barcode picks the item outright — no list to tap through. */
  const tryBarcode = async (code: string) => {
    const hit = await resolveBarcodeToProduct(code).catch(() => null);
    if (hit) {
      setPicked(hit);
      setSearch('');
    }
  };

  const missing: string[] = [];
  if (!selectedSiteId) missing.push('a venue');
  if (!picked) missing.push('the item');
  if (qty === null || qty <= 0) missing.push('a quantity');
  if (!reason.trim()) missing.push('a reason');
  const canSubmit = missing.length === 0 && !record.isPending;

  const reset = () => {
    setPicked(null);
    setQty(null);
    setReason('');
    setNote('');
    setSearch('');
  };

  const submit = async () => {
    if (!selectedSiteId || !picked || qty === null) return;
    setError(null);
    let res;
    try {
      res = await record.mutateAsync({
        siteId: selectedSiteId,
        productId: picked.id,
        productName: picked.name,
        qty,
        reason: reason.trim(),
        note: note.trim() || null,
        recordedBy: bakerName.trim() || null,
      });
    } catch (err) {
      setError({
        title: 'Not recorded',
        message: err instanceof Error ? err.message : 'Something went wrong. Your entry is still here.',
      });
      return;
    }
    if (res.status === 'rejected') {
      // Refused, not queued — everything typed stays exactly where it is.
      setError({
        title: 'Not recorded — the server refused this',
        message: res.error?.message ?? 'Your entry is still on this screen.',
      });
      return;
    }
    toast({ title: res.status === 'sent' ? 'Wastage recorded' : 'Saved offline — will sync' });
    reset();
  };

  return (
    <TouchScreen>
      <TouchTopbar
        title="Wastage"
        venue={selectedSite?.name ?? null}
        venueBound={isBound}
        onBack={() => void navigate({ to: '/' })}
        right={<PwaSyncPill />}
        stat={picked ? picked.name : 'Any stocked item can be marked as wasted'}
      />
      <div className="scroll">
        {error && (
          <ErrorBanner title={error.title} message={error.message} onDismiss={() => setError(null)} />
        )}

        {!picked ? (
          <>
            <TouchToolbar
              search={search}
              onSearch={(v) => {
                setSearch(v);
                // Barcodes arrive as a fast burst ending in Enter; a long
                // numeric string is a scan, not somebody typing a name.
                if (/^\d{8,14}$/.test(v.trim())) void tryBarcode(v.trim());
              }}
              placeholder="Search or scan an item…"
            />
            {search.trim().length < 2 && (
              <div className="empty">Search for the item that was wasted, or scan it.</div>
            )}
            {results.isPending && search.trim().length >= 2 && <div className="empty">Searching…</div>}
            {results.data?.length === 0 && (
              <div className="empty">Nothing matches “{search}”.</div>
            )}
            {(results.data ?? []).map((p) => (
              <button
                key={p.id}
                className="row row-tap"
                onClick={() => {
                  setPicked(p);
                  setSearch('');
                }}
              >
                <div className="meta">
                  <div className="name">{p.name}</div>
                  <div className="hint book">
                    {p.stockCode ? `${p.stockCode} · ` : ''}
                    per {uomFullNameSingular(p.stockUom) ?? p.stockUom}
                  </div>
                </div>
              </button>
            ))}
          </>
        ) : (
          <div className="center">
            <div className="field">
              <label>Item</label>
              <button className="input" style={{ textAlign: 'left', fontWeight: 700 }} onClick={reset}>
                {picked.name} — tap to change
              </button>
            </div>

            <div className="field">
              <label id="lbl-waste-qty">
                How much was wasted ({uomFullName(picked.stockUom) ?? picked.stockUom})
              </label>
              <button
                className="input"
                style={{ textAlign: 'left', fontWeight: 700 }}
                aria-labelledby="lbl-waste-qty"
                onClick={() => setQtyOpen(true)}
              >
                {qty !== null ? formatQtyUom(qty, picked.stockUom) : 'Tap to enter'}
              </button>
            </div>

            <div className="field">
              <label htmlFor="waste-reason">Reason</label>
              {/* Required. Wastage with no reason cannot be told from a
                  counting error, and nobody can act on it. */}
              <div
                className="toolbar"
                style={{ padding: 0, background: 'transparent', border: 'none', flexWrap: 'wrap' }}
              >
                {WASTAGE_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`chip${reason === r ? ' on' : ''}`}
                    onClick={() => setReason(r)}
                  >
                    {r}
                  </button>
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

            <div className="field">
              <label htmlFor="waste-note">Note (optional)</label>
              <input
                id="waste-note"
                className="input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onFocus={selectOnFocus}
                placeholder="What happened?"
              />
            </div>

            <div className="field">
              <label htmlFor="waste-by">Your name (optional)</label>
              <input
                id="waste-by"
                className="input"
                value={bakerName}
                onChange={(e) => setBakerName(e.target.value)}
                onFocus={selectOnFocus}
                autoCapitalize="words"
              />
            </div>
          </div>
        )}

        {(recent.data?.length ?? 0) > 0 && (
          <>
            <h2 className="section-head">Recorded today</h2>
            {(recent.data ?? []).slice(0, 10).map((w) => (
              <div className="row" key={w.id}>
                <div className="meta">
                  <div className="name">{w.productName}</div>
                  <div className="hint book">
                    {formatQtyUom(Number(w.qty), w.stockUom)} · {w.reason}
                    {w.recordedBy ? ` · ${w.recordedBy}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {picked && (
        <ActionBar>
          <BigButton variant="ok" disabled={!canSubmit} onClick={() => void submit()}>
            {record.isPending
              ? 'Recording…'
              : missing.length > 0
                ? `Enter ${missing[0]} to continue`
                : 'Record wastage'}
          </BigButton>
        </ActionBar>
      )}

      {qtyOpen && picked && (
        <KeypadSheet
          title={`${picked.name} — wasted (${uomFullName(picked.stockUom) ?? picked.stockUom})`}
          initial={qty ?? 0}
          onCancel={() => setQtyOpen(false)}
          onConfirm={(v) => {
            setQty(Math.max(0, v));
            setQtyOpen(false);
          }}
        />
      )}
    </TouchScreen>
  );
}
