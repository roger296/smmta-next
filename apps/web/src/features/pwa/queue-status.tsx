/**
 * Sync status + queue drawer for the venue screens (Aug-2026 feedback set,
 * defects A-2 / A-3 / A-4).
 *
 * On 12 Aug a venue user had no way to answer "did my count actually go in?".
 * The pill said "All saved" because it was wired to a mutation's `isPending`,
 * and the queue behind it was never replayed at all. This component is the
 * honest answer: real pending depth, a real replay trigger, and a drawer that
 * lists every unsent action with its error so the venue can retry or discard
 * it without ringing head office.
 */
import * as React from 'react';
import { BigButton, BottomSheet, SyncPill, type SyncState } from '@/components/touch/touch';
import { pwaQueue } from './use-pwa-jobs';
import { flushPwaQueueOnce, usePwaQueueState } from './use-pwa-jobs';
import type { QueuedAction } from '@/lib/offline-queue';

function describe(action: QueuedAction): string {
  if (action.label) return action.label;
  const endpoint = action.endpoint;
  if (endpoint.startsWith('/goods-in')) return 'Goods in';
  if (endpoint.includes('/counts')) return 'Stock-take counts';
  if (endpoint.startsWith('/session-consumption')) return 'End of bake';
  return `${action.method} ${endpoint}`;
}

function when(ts: number | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The pill itself — tap to open the drawer. */
export function PwaSyncPill() {
  const { pending, deadLettered, isFlushing, isOnline } = usePwaQueueState();
  const [open, setOpen] = React.useState(false);
  const waiting = pending.length + deadLettered.length;

  const state: SyncState = isFlushing
    ? 'syncing'
    : !isOnline
      ? 'offline'
      : waiting > 0
        ? 'pending'
        : 'synced';

  return (
    <>
      <SyncPill state={state} count={waiting} onClick={() => setOpen(true)} />
      {open && <QueueDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

export function QueueDrawer({ onClose }: { onClose: () => void }) {
  const { pending, deadLettered, isFlushing, isOnline, lastSyncedAt } = usePwaQueueState();
  const [confirmDiscard, setConfirmDiscard] = React.useState<string | null>(null);

  const discard = async (key: string) => {
    await pwaQueue.discard(key);
    setConfirmDiscard(null);
  };

  return (
    <BottomSheet title="Work waiting to sync" onClose={onClose}>
      <p className="lede">
        {isOnline ? 'Connected.' : 'No connection — work is held on this iPad.'}
        {lastSyncedAt ? ` Last synced ${when(lastSyncedAt)}.` : ''}
      </p>

      <div className="queue-section-title">Waiting to send ({pending.length})</div>
      {pending.length === 0 && <div className="queue-empty">Nothing waiting — everything has been sent.</div>}
      {pending.map((a) => (
        <div className="queue-item" key={a.idempotencyKey}>
          <div className="queue-meta">
            <div className="queue-label">{describe(a)}</div>
            <div className="queue-sub">
              {a.attempts ? `${a.attempts} attempt${a.attempts === 1 ? '' : 's'}` : 'Not yet tried'}
              {a.lastError ? ` · ${a.lastError}` : ''}
              {a.lastTriedAt ? ` · last ${when(a.lastTriedAt)}` : ''}
            </div>
          </div>
          <div className="queue-actions">
            {confirmDiscard === a.idempotencyKey ? (
              <>
                <button className="danger" onClick={() => void discard(a.idempotencyKey)}>
                  Really discard
                </button>
                <button onClick={() => setConfirmDiscard(null)}>Keep</button>
              </>
            ) : (
              <button className="danger" onClick={() => setConfirmDiscard(a.idempotencyKey)}>
                Discard
              </button>
            )}
          </div>
        </div>
      ))}

      {deadLettered.length > 0 && (
        <>
          <div className="queue-section-title">Gave up after repeated failures ({deadLettered.length})</div>
          {deadLettered.map((a) => (
            <div className="queue-item" key={a.idempotencyKey}>
              <div className="queue-meta">
                <div className="queue-label">{describe(a)}</div>
                <div className="queue-sub">{a.lastError ?? 'Failed repeatedly'}</div>
              </div>
              <div className="queue-actions">
                <button onClick={() => void pwaQueue.revive(a.idempotencyKey)}>Retry</button>
                {confirmDiscard === a.idempotencyKey ? (
                  <button className="danger" onClick={() => void discard(a.idempotencyKey)}>
                    Really discard
                  </button>
                ) : (
                  <button className="danger" onClick={() => setConfirmDiscard(a.idempotencyKey)}>
                    Discard
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      <div className="sheet-actions">
        <BigButton variant="ghost" onClick={onClose}>Close</BigButton>
        <BigButton
          variant="solid"
          disabled={isFlushing || !isOnline || pending.length === 0}
          onClick={() => void flushPwaQueueOnce()}
        >
          {isFlushing ? 'Sending…' : 'Retry now'}
        </BigButton>
      </div>
    </BottomSheet>
  );
}
