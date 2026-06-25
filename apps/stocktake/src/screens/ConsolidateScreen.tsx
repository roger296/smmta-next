import { useEffect, useState } from 'react';
import { PERIOD, SITES } from '../lib/catalogue';
import {
  exportCsvUrl,
  fetchConsolidation,
  fetchSites,
  resolveConflict,
  type ConsolidatedItem,
  type SiteConsolidation,
  type SiteSummary,
} from '../lib/api';

interface ConsolidateScreenProps {
  initialCode: string;
  onExit: () => void;
}

const siteName = (slug: string) => SITES.find((s) => s.slug === slug)?.name ?? slug;

/** Head-office view: see every site's submissions, settle conflicts, export the
 *  consolidated CSV. Behind the same shared access code as the counters. */
export function ConsolidateScreen({ initialCode, onExit }: ConsolidateScreenProps) {
  const [code, setCode] = useState(initialCode);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [con, setCon] = useState<SiteConsolidation | null>(null);
  const [resolving, setResolving] = useState<ConsolidatedItem | null>(null);

  const loadSites = async () => {
    setError(null);
    try {
      setSites(await fetchSites(code, PERIOD));
      setLoaded(true);
    } catch {
      setError('Could not load — check the access code.');
    }
  };

  const openSite = async (slug: string) => {
    setActive(slug);
    setCon(null);
    try {
      setCon(await fetchConsolidation(code, PERIOD, slug));
    } catch {
      setError('Could not load that site.');
    }
  };

  useEffect(() => {
    if (active) void openSite(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async (slug?: string) => {
    try {
      const res = await fetch(exportCsvUrl(PERIOD, slug), { headers: { 'x-stocktake-code': code } });
      if (!res.ok) throw new Error('export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = slug ? `stocktake-${PERIOD}-${slug}.csv` : `stocktake-${PERIOD}-all-sites.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch {
      setError('Export failed — check the access code.');
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-row">
          <button className="linkbtn" style={{ color: '#cdd3db' }} onClick={onExit}>
            ‹
          </button>
          <span className="topbar-title">Consolidate</span>
          <span className="topbar-sub">{PERIOD.replace('-', ' ')}</span>
        </div>
      </div>

      <div className="scroll">
        <div className="con-wrap">
          {error && <div className="notice" style={{ background: '#fbeaea', color: '#7a1f1f' }}>{error}</div>}

          {!loaded ? (
            <div className="con-card">
              <div className="field">
                <label>Access code</label>
                <input className="input" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="off" />
              </div>
              <button className="btn solid" onClick={() => void loadSites()}>
                Load sites
              </button>
            </div>
          ) : (
            <>
              <div className="notice">
                Conflicts (an item counted by more than one person) are listed below and held out of the CSV until you
                settle them.
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <button className="btn solid" style={{ width: 'auto', padding: '0 16px' }} onClick={() => void download()}>
                  Export all sites
                </button>
                <button className="btn ghost" style={{ width: 'auto', padding: '0 16px' }} onClick={() => void loadSites()}>
                  Refresh
                </button>
              </div>

              {sites.length === 0 && <p style={{ color: 'var(--muted)' }}>No counts submitted yet.</p>}

              {sites.map((s) => (
                <div key={s.siteSlug} className="con-card">
                  <div className="con-row">
                    <strong style={{ flex: 1 }}>{siteName(s.siteSlug)}</strong>
                    {s.conflictCount > 0 ? (
                      <span className="pill conflict">{s.conflictCount} conflict{s.conflictCount > 1 ? 's' : ''}</span>
                    ) : (
                      <span className="pill ok">clear</span>
                    )}
                    <span style={{ color: 'var(--muted)', fontSize: 13 }}>{s.itemCount} items</span>
                  </div>
                  <div className="con-contribs" style={{ marginTop: 6 }}>
                    Counted by: {s.counters.join(', ') || '—'}
                  </div>
                  <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
                    <button className="linkbtn" onClick={() => void openSite(s.siteSlug)}>
                      {active === s.siteSlug ? 'Hide details' : 'View / resolve'}
                    </button>
                    <button className="linkbtn" onClick={() => void download(s.siteSlug)}>
                      Export this site
                    </button>
                  </div>

                  {active === s.siteSlug && con && (
                    <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                      {con.items.map((item) => (
                        <div key={item.groupKey} className="con-item">
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>
                              {item.itemName}
                              {item.isCustom && <span className="badge-added">added</span>}
                            </div>
                            {item.status === 'CONFLICT' && (
                              <div className="con-contribs">
                                {item.contributors.map((c) => `${c.counterName}: ${c.quantity}`).join('  ·  ')}
                              </div>
                            )}
                          </div>
                          {item.status === 'CONFLICT' ? (
                            <>
                              <span className="pill conflict">conflict</span>
                              <button className="linkbtn" onClick={() => setResolving(item)}>
                                Resolve
                              </button>
                            </>
                          ) : (
                            <span className="table-num">{item.quantity}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {resolving && active && (
        <ResolveSheet
          item={resolving}
          onCancel={() => setResolving(null)}
          onConfirm={async (qty) => {
            try {
              await resolveConflict(code, {
                period: PERIOD,
                siteSlug: active,
                groupKey: resolving.groupKey,
                resolvedQty: qty,
                resolvedBy: 'Head office',
              });
              setResolving(null);
              await openSite(active);
              await loadSites();
            } catch {
              setError('Could not save resolution.');
            }
          }}
        />
      )}
    </div>
  );
}

function ResolveSheet({
  item,
  onCancel,
  onConfirm,
}: {
  item: ConsolidatedItem;
  onCancel: () => void;
  onConfirm: (qty: number) => void;
}) {
  const [value, setValue] = useState('');
  const num = Number(value);
  const valid = value !== '' && Number.isFinite(num) && num >= 0;
  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{item.itemName}</h2>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>Pick the correct figure, or type your own.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          {item.contributors.map((c) => (
            <button
              key={c.deviceId}
              className="chip"
              onClick={() => setValue(String(c.quantity))}
            >
              {c.counterName}: {c.quantity}
            </button>
          ))}
        </div>
        <div className="field">
          <label>Agreed quantity</label>
          <input
            className="input"
            type="number"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            min={0}
            step="any"
            autoFocus
          />
        </div>
        <div className="sheet-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn solid"
            disabled={!valid}
            style={{ opacity: valid ? 1 : 0.5 }}
            onClick={() => onConfirm(num)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
