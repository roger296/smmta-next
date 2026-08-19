/*
 * Reusable touch-first primitives for the in-venue iPad PWA pages, carrying the
 * proven stock-take-lite design (big targets, ± steppers, hero value, tap-to-type
 * keypad, sticky top bar + progress). All markup uses the scoped `.touch-app`
 * design system in ./pwa-touch.css — import TouchScreen and everything renders
 * full-screen over the admin chrome.
 */
import * as React from 'react';
import { useNumericEntry } from './use-numeric-entry';
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

/**
 * Select a text input's content on focus (Aug-2026, D-4 on the plain fields).
 *
 * The keypad's first-keystroke-replaces fix covers the touch path; the plain
 * `.input` fields in the details and wastage sheets are typed on a laptop
 * keyboard, where the same problem appears as "the caret lands after the
 * default and I type into it". Selecting means typing replaces, which is what
 * every other field on every other system does.
 */
export function selectOnFocus(event: React.FocusEvent<HTMLInputElement>): void {
  event.target.select();
}

/**
 * Full-screen touch shell.
 *
 * Sizing and the keyboard-tracking offset live in `pwa-touch.css`, driven by
 * the `--tvv-*` variables `TouchViewportLock` publishes (defect B-1).
 *
 * The one behaviour that belongs here rather than in CSS: keeping a focused
 * control in view. `scrollIntoView({ block: 'nearest' })` is scoped to the
 * `.scroll` container — never a document-level scroll, which on iOS is exactly
 * what dragged the whole fixed shell off the top of the glass.
 */
export function TouchScreen({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.closest !== 'function') return;
      // Only inside the scrolling body. A focus on the topbar or the action
      // bar must not scroll anything — they are already pinned.
      if (!target.closest('.scroll')) return;
      // Deferred a frame: on iOS the visual viewport has not resized yet at
      // focusin, so scrolling now would aim at the pre-keyboard geometry.
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    };

    root.addEventListener('focusin', onFocusIn);
    return () => root.removeEventListener('focusin', onFocusIn);
  }, []);

  return (
    <div className="touch-app" ref={ref}>
      {children}
    </div>
  );
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

/**
 * A refusal, not a warning (Aug-2026 feedback, F-6).
 *
 * "No bake logs were submitted due to incorrect recipe data." The screen used
 * to show a transient toast and an empty ingredient list, which reads as
 * "nothing to record today". This states what is wrong, names the cake / date
 * / venue it is wrong for, and says plainly that the bake cannot be filed —
 * so a baker escalates instead of shrugging.
 *
 * Deliberately not dismissible: dismissing it would restore exactly the
 * silent-empty-form state the defect describes.
 */
export function BlockingNotice({
  title, reasons, detail, children,
}: {
  title: React.ReactNode;
  reasons: readonly { kind: string; message: string }[];
  detail?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="notice block" role="alert" aria-live="assertive">
      <strong>{title}</strong>
      {detail != null && <div className="notice-detail">{detail}</div>}
      <ul className="notice-reasons">
        {reasons.map((r) => (
          <li key={r.kind + r.message}>{r.message}</li>
        ))}
      </ul>
      <p className="notice-verdict">This bake cannot be submitted.</p>
      {children}
    </div>
  );
}

export function TouchTopbar({
  title, sub, venue, venueBound = true, onVenueClick, onBack, right, stat, progress,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  /**
   * The venue this screen is working against — REQUIRED (defect B-5).
   *
   * Not optional, deliberately. It was optional before, and the stock-take
   * start screen and the End of Bake setup screen simply never passed it —
   * which is how a South London iPad booked 100 kg to Birmingham with nothing
   * on screen contradicting it (E-1). Pass the resolved name, or `null` while
   * it is still loading; there is no third option that omits it.
   */
  venue: React.ReactNode | null;
  /** False when the site was defaulted rather than bound to this device. */
  venueBound?: boolean;
  onVenueClick?: () => void;
  onBack?: () => void;
  right?: React.ReactNode;
  stat?: React.ReactNode;
  progress?: number; // 0..100
}) {
  const venueLabel = venue ?? 'No venue set';
  const venueClass = `venue-chip${venueBound ? '' : ' warn'}`;
  const venueTitle = venueBound ? undefined : 'Not set for this device — tap to choose';

  return (
    <div className="topbar">
      <div className="topbar-row">
        {onBack && (
          <button className="backbtn" onClick={onBack} aria-label="Back">‹</button>
        )}
        <span className="topbar-title">{title}</span>
        {onVenueClick ? (
          <button type="button" className={venueClass} onClick={onVenueClick} title={venueTitle} aria-label={`Venue: ${venueLabel}. Tap to change.`}>
            {venueLabel}
            {!venueBound && ' — tap to choose'}
          </button>
        ) : (
          <span className={venueClass} title={venueTitle}>
            {venueLabel}
            {!venueBound && ' — not set for this device'}
          </span>
        )}
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

/**
 * Confirm before losing uncommitted work (Aug-2026 feedback set, A-5).
 *
 * "Lack of visual feedback on screen exits leaves users uncertain whether
 * inputs are saved, deleted, or processed." Back used to discard silently, so
 * there was no way to tell a successful save from a lost one.
 */
export function DiscardGuardSheet({
  title, message, discardLabel = 'Discard', keepLabel = 'Keep editing', onDiscard, onKeep,
}: {
  title: React.ReactNode;
  message: React.ReactNode;
  discardLabel?: string;
  keepLabel?: string;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  return (
    <BottomSheet title={title} onClose={onKeep}>
      <p className="lede">{message}</p>
      <div className="sheet-actions">
        {/* "Keep editing" is the SOLID one: the safe choice should be the one
            a thumb finds first. */}
        <BigButton variant="solid" onClick={onKeep}>{keepLabel}</BigButton>
        <BigButton variant="ghost" onClick={onDiscard}>{discardLabel}</BigButton>
      </div>
    </BottomSheet>
  );
}

/**
 * A time-boxed undo (Aug-2026 feedback set, defect E-3).
 *
 * "Accidental booking logged 100kg to Birmingham; requested an undo timer."
 * The countdown is shown, not implied: a window you cannot see the end of is
 * one you cannot rely on. When it lapses the bar removes itself and a site
 * manager can still void the receipt from the admin — the undo is a
 * convenience over the reversal, never the only route to it.
 */
export function UndoBar({
  message, actionLabel = 'Undo', seconds = 90, disabled, onAction, onExpire,
}: {
  message: React.ReactNode;
  actionLabel?: string;
  seconds?: number;
  disabled?: boolean;
  onAction: () => void;
  onExpire: () => void;
}) {
  const [remaining, setRemaining] = React.useState(seconds);
  // Held in a ref so the interval below never needs `onExpire` in its deps —
  // a caller passing an inline arrow would otherwise restart the countdown on
  // every render, and the window would never end.
  const expireRef = React.useRef(onExpire);
  expireRef.current = onExpire;

  React.useEffect(() => {
    setRemaining(seconds);
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(id);
          expireRef.current();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [seconds]);

  return (
    <div className="undobar" role="status">
      <span className="undobar-message">{message}</span>
      <span className="undobar-timer" aria-hidden>{remaining}s</span>
      <button type="button" className="undobar-action" onClick={onAction} disabled={disabled}>
        {actionLabel}
      </button>
    </div>
  );
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

export function BottomSheet({
  title, onClose, children, onKeyDown,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  onKeyDown?: (event: React.KeyboardEvent) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  // Where focus was before the sheet opened, so it can be given back (D-5).
  const restoreRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Focus the sheet itself so keystrokes reach `onKeyDown` immediately —
    // "type 3, press Enter" must work without hunting for a control first.
    ref.current?.focus();
    return () => restoreRef.current?.focus?.();
  }, []);

  /** Keep Tab inside the sheet while it is open. */
  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const focusable = ref.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          trapTab(event);
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          onKeyDown?.(event);
        }}
      >
        {title != null && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

/**
 * The keypad's own display + keys, shared by every sheet that takes a number
 * (Aug-2026, D-4/D-5). Extracted so `KeypadSheet` and the wastage keypad —
 * which were near-duplicates — cannot drift apart again.
 */
export function NumericKeypad({
  entry, allowDecimal = true,
}: {
  entry: ReturnType<typeof useNumericEntry>;
  allowDecimal?: boolean;
}) {
  return (
    <>
      {/* A live region: the value changes without focus moving, so a screen
          reader would otherwise never hear the number being typed. */}
      <div className="keydisplay" role="status" aria-live="polite" aria-atomic="true">
        {entry.value || '0'}
      </div>
      {/* D-4: the starting value stays visible, so replacing it loses nothing. */}
      {entry.pristine && entry.initial !== 0 && (
        <div className="keydisplay-was">was {entry.initial}</div>
      )}
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button key={k} type="button" className="key" aria-label={k} onClick={() => entry.push(k)}>
            {k}
          </button>
        ))}
        <button
          type="button"
          className="key"
          aria-label="Decimal point"
          onClick={() => entry.push('.')}
          disabled={!allowDecimal}
        >
          .
        </button>
        <button type="button" className="key" aria-label="0" onClick={() => entry.push('0')}>
          0
        </button>
        <button type="button" className="key" onClick={entry.backspace} aria-label="Backspace">
          ⌫
        </button>
      </div>
    </>
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
  const entry = useNumericEntry({ initial, allowDecimal });

  const confirm = () => {
    if (entry.valid) onConfirm(entry.numeric);
  };

  return (
    <BottomSheet
      title={title}
      onClose={onCancel}
      // D-5: "Request to enable direct number pad typing on laptop keyboards."
      // 0-9 and . push, Backspace deletes, Enter confirms, Escape cancels.
      onKeyDown={(event) => {
        const action = entry.handleKey(event);
        if (action === 'confirm') confirm();
        if (action === 'cancel') onCancel();
      }}
    >
      <NumericKeypad entry={entry} allowDecimal={allowDecimal} />
      <div className="sheet-actions">
        <BigButton variant="ghost" onClick={onCancel}>Cancel</BigButton>
        <BigButton variant="solid" disabled={!entry.valid} onClick={confirm}>Save</BigButton>
      </div>
    </BottomSheet>
  );
}
