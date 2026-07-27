import { useEffect, useMemo, useRef, useState } from 'react';
import { groupCatalogue, loadCatalogue, SITES } from '../lib/catalogue';
import { loadCounts, saveCounts, setCount } from '../lib/storage';
import { dirtyCounted, pushCounts } from '../lib/api';
import type { CatalogueItem, CountsMap, Session } from '../lib/types';
import { ItemRow } from '../components/ItemRow';
import { countingLabel } from '../lib/units';

type Filter = 'all' | 'todo';
type SyncState = 'synced' | 'pending' | 'offline' | 'syncing';

interface CountScreenProps {
  session: Session;
  onExit: () => void;
}

interface TypeTarget {
  itemKey: string;
  name: string;
  base: Parameters<typeof setCount>[1];
}

const newCustomKey = () =>
  `custom:${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

export function CountScreen({ session, onExit }: CountScreenProps) {
  const [counts, setCounts] = useState<CountsMap>(() => loadCounts(session.period, session.siteSlug));
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sync, setSync] = useState<SyncState>('synced');
  const [showAdd, setShowAdd] = useState(false);
  const [typeTarget, setTypeTarget] = useState<TypeTarget | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The sheet comes from the product catalogue, fetched on load. Until it
  // arrives we render nothing rather than the stale bundle, so a counter never
  // starts against a list that is about to be replaced under them.
  const [items, setItems] = useState<CatalogueItem[] | null>(null);
  const [catalogueSource, setCatalogueSource] = useState<'live' | 'cache' | 'bundled'>('live');

  useEffect(() => {
    let cancelled = false;
    void loadCatalogue(session.accessCode).then((r) => {
      if (cancelled) return;
      setItems(r.items);
      setCatalogueSource(r.source);
    });
    return () => {
      cancelled = true;
    };
  }, [session.accessCode]);

  const groups = useMemo(() => groupCatalogue(items ?? []), [items]);
  const customEntries = useMemo(
    () => Object.values(counts).filter((c) => c.isCustom),
    [counts],
  );

  const total = (items?.length ?? 0) + customEntries.length;
  const countedTotal = Object.values(counts).filter((c) => c.counted).length;
  const pct = total === 0 ? 0 : Math.round((countedTotal / total) * 100);
  const siteName = SITES.find((s) => s.slug === session.siteSlug)?.name ?? session.siteSlug;

  // Persist on every change.
  useEffect(() => {
    saveCounts(session.period, session.siteSlug, counts);
  }, [counts, session.period, session.siteSlug]);

  // Sync: whenever there are dirty entries, try to push (debounced); also retry
  // on a timer and when connectivity returns.
  useEffect(() => {
    let cancelled = false;
    const flush = async () => {
      const pending = dirtyCounted(counts);
      if (pending.length === 0) {
        if (!cancelled) setSync('synced');
        return;
      }
      if (!navigator.onLine) {
        if (!cancelled) setSync('offline');
        return;
      }
      if (!cancelled) setSync('syncing');
      const res = await pushCounts(session, pending);
      if (cancelled) return;
      if (res.ok) {
        const keys = new Set(pending.map((p) => p.itemKey));
        setCounts((prev) => {
          const next = { ...prev };
          for (const k of keys) if (next[k]) next[k] = { ...next[k]!, dirty: false };
          return next;
        });
        setSync('synced');
      } else {
        setSync(navigator.onLine ? 'pending' : 'offline');
      }
    };
    const t = setTimeout(flush, 800);
    const interval = setInterval(flush, 15000);
    window.addEventListener('online', flush);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(interval);
      window.removeEventListener('online', flush);
    };
  }, [counts, session]);

  const apply = (base: Parameters<typeof setCount>[1], quantity: number) => {
    setCounts((prev) => setCount(prev, base, quantity));
  };

  const baseForItem = (item: CatalogueItem): Parameters<typeof setCount>[1] => ({
    itemKey: item.key,
    itemName: item.name,
    section: item.section,
    // Live catalogue lines carry no pack hint — only the bundled fallback does.
    packSize: item.pack ?? null,
    isCustom: false,
  });

  const matches = (item: { name: string; section: string | null }) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return item.name.toLowerCase().includes(q) || (item.section ?? '').toLowerCase().includes(q);
  };

  const showItem = (key: string) => filter === 'all' || !(counts[key]?.counted ?? false);

  const syncLabel =
    sync === 'synced'
      ? 'All synced'
      : sync === 'syncing'
        ? 'Syncing…'
        : sync === 'offline'
          ? 'Offline — saved'
          : 'Pending sync';
  const syncClass = sync === 'synced' || sync === 'syncing' ? 'ok' : sync === 'offline' ? 'offline' : 'pending';

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-row">
          <button className="linkbtn" style={{ color: '#cdd3db' }} onClick={onExit} aria-label="Change site">
            ‹
          </button>
          <span className="topbar-title">{siteName}</span>
          <span className="topbar-sub">{session.counterName}</span>
          <span className="topbar-spacer" />
          <span className={`syncpill ${syncClass}`}>{syncLabel}</span>
        </div>
        <div className="topbar-row" style={{ minHeight: 0, paddingBottom: 8 }}>
          <span className="topbar-stat">
            {countedTotal} / {total} counted
            {items !== null && catalogueSource !== 'live' && (
              // Say so rather than let a stale list pass as the current one.
              <span className="topbar-stale">
                {catalogueSource === 'cache' ? ' · offline list' : ' · built-in list'}
              </span>
            )}
          </span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search"
          placeholder="Search items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className={`chip${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>
          All
        </button>
        <button className={`chip${filter === 'todo' ? ' on' : ''}`} onClick={() => setFilter('todo')}>
          Not counted
        </button>
      </div>

      <div className="scroll" ref={scrollRef}>
        <div className="add-bar">
          <button className="btn" onClick={() => setShowAdd(true)}>
            + Add item not on the list
          </button>
        </div>

        {groups.map((g) => {
          const visible = g.items.filter((it) => matches(it) && showItem(it.key));
          if (visible.length === 0) return null;
          return (
            <section key={g.id} id={g.id}>
              <div className="sec-head">
                {g.area && <div className="sec-area">{g.area}</div>}
                {g.section && <div className="sec-name">{g.section}</div>}
              </div>
              {visible.map((item) => (
                <ItemRow
                  key={item.key}
                  name={item.name}
                  hint={countingLabel(item.uom)}
                  isCustom={false}
                  entry={counts[item.key]}
                  onSet={(q) => apply(baseForItem(item), q)}
                  onType={() =>
                    setTypeTarget({ itemKey: item.key, name: item.name, base: baseForItem(item) })
                  }
                />
              ))}
            </section>
          );
        })}

        {customEntries.filter((c) => matches({ name: c.itemName, section: c.section }) && showItem(c.itemKey)).length > 0 && (
          <section>
            <div className="sec-head">
              <div className="sec-area">Added on the day</div>
              <div className="sec-name">Custom items</div>
            </div>
            {customEntries
              .filter((c) => matches({ name: c.itemName, section: c.section }) && showItem(c.itemKey))
              .map((c) => (
                <ItemRow
                  key={c.itemKey}
                  name={c.itemName}
                  hint={c.packSize}
                  isCustom
                  entry={c}
                  onSet={(q) =>
                    apply(
                      {
                        itemKey: c.itemKey,
                        itemName: c.itemName,
                        section: c.section,
                        packSize: c.packSize,
                        isCustom: true,
                      },
                      q,
                    )
                  }
                  onType={() =>
                    setTypeTarget({
                      itemKey: c.itemKey,
                      name: c.itemName,
                      base: {
                        itemKey: c.itemKey,
                        itemName: c.itemName,
                        section: c.section,
                        packSize: c.packSize,
                        isCustom: true,
                      },
                    })
                  }
                />
              ))}
          </section>
        )}

        <div className="add-bar">
          <button className="btn" onClick={() => setShowAdd(true)}>
            + Add item not on the list
          </button>
        </div>
      </div>

      {showAdd && (
        <AddItemSheet
          onCancel={() => setShowAdd(false)}
          onAdd={(name, pack) => {
            const key = newCustomKey();
            apply(
              { itemKey: key, itemName: name, section: 'Custom items', packSize: pack || null, isCustom: true },
              0,
            );
            setShowAdd(false);
          }}
        />
      )}

      {typeTarget && (
        <KeypadSheet
          name={typeTarget.name}
          initial={counts[typeTarget.itemKey]?.quantity ?? 0}
          onCancel={() => setTypeTarget(null)}
          onConfirm={(q) => {
            apply(typeTarget.base, q);
            setTypeTarget(null);
          }}
        />
      )}
    </div>
  );
}

function AddItemSheet({
  onCancel,
  onAdd,
}: {
  onCancel: () => void;
  onAdd: (name: string, pack: string) => void;
}) {
  const [name, setName] = useState('');
  const [pack, setPack] = useState('');
  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Add an item</h2>
        <div className="field">
          <label>Product name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoCapitalize="words" />
        </div>
        <div className="field">
          <label>Pack size (optional)</label>
          <input className="input" value={pack} onChange={(e) => setPack(e.target.value)} placeholder="e.g. 5kg" />
        </div>
        <div className="sheet-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn solid"
            disabled={name.trim().length === 0}
            style={{ opacity: name.trim() ? 1 : 0.5 }}
            onClick={() => onAdd(name.trim(), pack.trim())}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function KeypadSheet({
  name,
  initial,
  onCancel,
  onConfirm,
}: {
  name: string;
  initial: number;
  onCancel: () => void;
  onConfirm: (q: number) => void;
}) {
  const [value, setValue] = useState(String(initial));
  const num = Number(value);
  const valid = value !== '' && Number.isFinite(num) && num >= 0;
  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{name}</h2>
        <div className="field">
          <label>Quantity in stock</label>
          <input
            className="input"
            type="number"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            min={0}
            step="any"
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
