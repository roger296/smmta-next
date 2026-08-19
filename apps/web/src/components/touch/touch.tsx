/*
 * Reusable touch-first primitives for the in-venue iPad PWA pages, carrying the
 * proven stock-take-lite design (big targets, ± steppers, hero value, tap-to-type
 * keypad, sticky top bar + progress). All markup uses the scoped `.touch-app`
 * design system in ./pwa-touch.css — import TouchScreen and everything renders
 * full-screen over the admin chrome.
 */
import * as React from 'react';
import './pwa-touch.css';

/** Add/replace the fractional part while keeping the whole number (4 + ½ = 4.5;
 *  tapping the active fraction again clears it back to 4). */
export function partUnit(current: number, fraction: number): number {
  const whole = Math.floor(current);
  const remainder = Math.round((current - whole) * 100) / 100;
  const next = Math.abs(remainder - fraction) < 0.001 ? whole : whole + fraction;
  return Math.round(next * 100) / 100;
}

export type SyncState = 'synced' | 'syncing' | 'pending' | 'offline';

/** Full-screen touch shell — renders a fixed overlay above the admin SPA. */
export function TouchScreen({ children }: { children: React.ReactNode }) {
  return <div className="touch-app">{children}</div>;
}

/**
 * The sync pill. Presentational only — see `PwaSyncPill`
 * (features/pwa/queue-status.tsx) for the wired version that reads real queue
 * depth. Driving this from a mutation's `isPending` was defect A-3: the
 * `pending` and `offline` branches below were unreachable, so a queue holding
 * unsent counts still read "All saved".
 *
 * `count` is rendered when there is queued work, because "Pending" alone does
 * not answer the question a baker actually has, which is *how much*.
 */
export function SyncPill({
  state, count = 0, onClick,
}: {
  state: SyncState;
  count?: number;
  onClick?: () => void;
}) {
  const label =
    state === 'synced' ? 'All saved'
    : state === 'syncing' ? 'Saving…'
    : state === 'offline' ? (count > 0 ? `Offline — ${count} waiting` : 'Offline')
    : count > 0 ? `Pending ${count}` : 'Pending';
  const cls = state === 'synced' || state === 'syncing' ? 'ok' : state === 'offline' ? 'offline' : 'pending';
  if (!onClick) return <span className={`syncpill ${cls}`}>{label}</span>;
  return (
    <button type="button" className={`syncpill ${cls}`} onClick={onClick} aria-label={`Sync status: ${label}. Open the queue.`}>
      {label}
    </button>
  );
}

/**
 * A persistent, dismissible in-screen error. Deliberately NOT a corner toast:
 * on 12 Aug a rejected submission produced a toast that vanished while the
 * baker was still looking at the shelf, so the failure was never seen. This
 * sits in the flow of the screen and stays until dismissed.
 */
export function ErrorBanner({
  title, message, onDismiss, children,
}: {
  title?: React.ReactNode;
  message: React.ReactNode;
  onDismiss?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="notice warn notice-error" role="alert">
      <div className="notice-body">
        {title != null && <strong>{title}</strong>}
        <div>{message}</div>
        {children}
      </div>
      {onDismiss && (
        <button type="button" className="notice-dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export function TouchTopbar({
  title, sub, onBack, right, stat, progress,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  onBack?: () => void;
  right?: React.ReactNode;
  stat?: React.ReactNode;
  progress?: number; // 0..100
}) {
  return (
    <div className="topbar">
      <div className="topbar-row">
        {onBack && (
          <button className="backbtn" onClick={onBack} aria-label="Back">‹</button>
        )}
        <span className="topbar-title">{title}</span>
        {sub != null && <span className="topbar-sub">{sub}</span>}
        <span className="topbar-spacer" />
        {right}
      </div>
      {stat != null && (
        <div className="topbar-row" style={{ minHeight: 0, paddingBottom: 8 }}>
          <span className="topbar-stat">{stat}</span>
        </div>
      )}
      {progress !== undefined && (
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}
    </div>
  );
}

export function TouchToolbar({
  search, onSearch, placeholder, children,
}: {
  search: string;
  onSearch: (v: string) => void;
  placeholder?: string;
  children?: React.ReactNode; // filter chips
}) {
  return (
    <div className="toolbar">
      <input
        className="search"
        placeholder={placeholder ?? 'Search…'}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />
      {children}
    </div>
  );
}

export function TouchChip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`chip${on ? ' on' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function BigButton({
  variant = 'outline', onClick, disabled, children, type = 'button',
}: {
  variant?: 'outline' | 'solid' | 'ok' | 'ghost';
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  type?: 'button' | 'submit';
}) {
  const cls = variant === 'solid' ? 'solid' : variant === 'ok' ? 'ok' : variant === 'ghost' ? 'ghost' : '';
  return (
    <button type={type} className={`btn ${cls}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function ActionBar({ children }: { children: React.ReactNode }) {
  return <div className="actionbar">{children}</div>;
}

const FRACTIONS: Array<{ label: string; value: number }> = [
  { label: '¼', value: 0.25 },
  { label: '½', value: 0.5 },
  { label: '¾', value: 0.75 },
];

/** One count line: status dot, name + hint, then − / value / + / big 0, plus an
 *  optional ½-unlock revealing ¼ ½ ¾ for part-units. `onSet(q)` marks it counted
 *  (0 is a real count). When not counted the value shows "—". */
export function CountRow({
  name, hint, counted, qty, onSet, onType, status, badge, fractions = true,
}: {
  name: React.ReactNode;
  hint?: React.ReactNode;
  counted: boolean;
  qty: number;
  onSet: (q: number) => void;
  onType: () => void;
  status?: 'done' | 'todo' | 'warn';
  badge?: React.ReactNode;
  fractions?: boolean;
}) {
  const [fracOpen, setFracOpen] = React.useState(false);
  const dot = status ?? (counted ? 'done' : 'todo');
  const remainder = Math.round((qty - Math.floor(qty)) * 100) / 100;
  return (
    <div className="row">
      <div className={`status status-${dot}`} aria-hidden="true">
        {dot === 'done' ? '●' : dot === 'warn' ? '!' : '○'}
      </div>
      <div className="meta">
        <div className="name">
          {name}
          {badge}
        </div>
        {hint != null && <div className="hint">{hint}</div>}
      </div>
      <div className="qty-controls">
        <button className="step" aria-label="Decrease" onClick={() => onSet(Math.max(0, (counted ? qty : 0) - 1))}>
          −
        </button>
        <button className={`qty-value${counted ? '' : ' todo'}`} aria-label="Type quantity" onClick={onType}>
          {counted ? qty : '—'}
        </button>
        <button className="step" aria-label="Increase" onClick={() => onSet((counted ? qty : 0) + 1)}>
          +
        </button>
        <button className="zero" aria-label="Set to zero" onClick={() => onSet(0)}>
          0
        </button>
        {fractions && (fracOpen ? (
          <span className="qty-controls" role="group" aria-label="Part quantity">
            {FRACTIONS.map((f) => (
              <button
                key={f.label}
                className={`zero${Math.abs(remainder - f.value) < 0.001 ? ' on' : ''}`}
                onClick={() => onSet(partUnit(counted ? qty : 0, f.value))}
              >
                {f.label}
              </button>
            ))}
          </span>
        ) : (
          <button className="zero" aria-label="Add a part-unit" onClick={() => setFracOpen(true)}>
            ½
          </button>
        ))}
      </div>
    </div>
  );
}

export function BottomSheet({ title, onClose, children }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        {title != null && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

/** On-screen number keypad (0-9, decimal, backspace) — the touch-native way to
 *  type an exact quantity without the OS keyboard. Supports decimals for part-units. */
export function KeypadSheet({
  title, initial, onCancel, onConfirm, allowDecimal = true,
}: {
  title: React.ReactNode;
  initial: number;
  onCancel: () => void;
  onConfirm: (q: number) => void;
  allowDecimal?: boolean;
}) {
  const [value, setValue] = React.useState(initial ? String(initial) : '');
  const push = (ch: string) => {
    setValue((v) => {
      if (ch === '.' && (v.includes('.') || !allowDecimal)) return v;
      if (ch === '.' && v === '') return '0.';
      if (v === '0' && ch !== '.') return ch;
      return (v + ch).slice(0, 9);
    });
  };
  const num = Number(value);
  const valid = value !== '' && Number.isFinite(num) && num >= 0;
  return (
    <BottomSheet title={title} onClose={onCancel}>
      <div className="keydisplay">{value || '0'}</div>
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button key={k} className="key" onClick={() => push(k)}>{k}</button>
        ))}
        <button className="key" onClick={() => push('.')} disabled={!allowDecimal}>.</button>
        <button className="key" onClick={() => push('0')}>0</button>
        <button className="key" onClick={() => setValue((v) => v.slice(0, -1))} aria-label="Backspace">⌫</button>
      </div>
      <div className="sheet-actions">
        <BigButton variant="ghost" onClick={onCancel}>Cancel</BigButton>
        <BigButton variant="solid" disabled={!valid} onClick={() => onConfirm(num)}>Save</BigButton>
      </div>
    </BottomSheet>
  );
}
