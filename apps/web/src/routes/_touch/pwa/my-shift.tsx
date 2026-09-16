import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useSiteContext } from '@/features/sites/site-context';
import { usePwaQueueState } from '@/features/pwa/use-pwa-jobs';
import { PwaSyncPill } from '@/features/pwa/queue-status';
import { JOB_LABELS, listShift, type ShiftEntry } from '@/features/pwa/shift-log';
import { TouchScreen, TouchTopbar } from '@/components/touch/touch';

export const Route = createFileRoute('/_touch/pwa/my-shift')({
  component: MyShiftScreen,
});

/**
 * What you have filed since you signed in (Sept-2026 user testing, item 9).
 *
 * "Staff noted that users should be able to see what they have submitted during
 *  the current logged in session, please add a page where they can see all of
 *  their submissions from the current logged in session."
 *
 * This is a reassurance screen, so it must be honest about the thing that
 * makes reassurance hard: a job filed in a cellar with no signal has not
 * reached the server yet. Those show as WAITING TO SEND rather than being
 * hidden or quietly counted as done — the same principle as defect A-1, where
 * a screen said "saved" about work that was sitting in a queue.
 */
function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MyShiftScreen() {
  const navigate = useNavigate();
  const { selectedSite, isBound } = useSiteContext();
  const queue = usePwaQueueState();

  // Re-read whenever the queue changes: a job that syncs in the background
  // moves from "waiting to send" to "sent", and this screen should show that
  // happen rather than needing a reload.
  const [entries, setEntries] = React.useState<ShiftEntry[]>(() => listShift());
  React.useEffect(() => {
    setEntries(listShift());
  }, [queue.pending.length, queue.lastSyncedAt]);

  const waiting = entries.filter((e) => e.status === 'queued').length;

  return (
    <TouchScreen>
      <TouchTopbar
        title="My shift"
        venue={selectedSite?.name ?? null}
        venueBound={isBound}
        onBack={() => void navigate({ to: '/' })}
        right={<PwaSyncPill />}
        stat={
          entries.length === 0
            ? 'Nothing filed yet'
            : `${entries.length} submission${entries.length === 1 ? '' : 's'}` +
              (waiting > 0 ? ` · ${waiting} waiting to send` : '')
        }
      />
      <div className="scroll">
        {entries.length === 0 && (
          <div className="empty">
            Nothing filed since you signed in. Anything you record — a delivery, a bake, a
            count, a wastage — will be listed here.
          </div>
        )}
        {entries.map((e) => (
          <div className="row" key={e.id}>
            <div
              className={`status status-${e.status === 'sent' ? 'done' : 'todo'}`}
              aria-hidden="true"
            >
              {e.status === 'sent' ? '●' : '!'}
            </div>
            <div className="meta">
              <div className="name">{e.label || JOB_LABELS[e.kind]}</div>
              <div className="hint book">
                {JOB_LABELS[e.kind]} · {formatClock(e.at)}
                {e.detail ? ` · ${e.detail}` : ''}
              </div>
              {/* Never "saved" about something still in the queue — that is
                  precisely the lie defect A-1 was about. */}
              {e.status === 'queued' && (
                <span className="badge warn">Waiting to send</span>
              )}
            </div>
          </div>
        ))}
        {entries.length > 0 && (
          <p className="field-note" style={{ padding: '12px 16px' }}>
            This list covers the current sign-in only. Signing out and back in starts a new one.
          </p>
        )}
      </div>
    </TouchScreen>
  );
}
