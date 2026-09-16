/**
 * What you have filed since you signed in (Sept-2026 user testing, item 9).
 *
 * "Staff noted that users should be able to see what they have submitted during
 *  the current logged in session, please add a page where they can see all of
 *  their submissions from the current logged in session."
 *
 * ── WHY THIS IS HELD ON THE DEVICE ─────────────────────────────────────────
 * It could be read back from the server, and for consumption records it partly
 * could. But the question is "what have *I* filed since I tapped my PIN in",
 * and:
 *
 *   · Venue iPads are shared. The server knows the site and the baker's typed
 *     name, neither of which identifies a login.
 *   · Some of it has not reached the server yet. A count taken in a cellar with
 *     no signal sits in the offline queue, and the screen that is supposed to
 *     reassure the baker it was recorded must show it, not omit it.
 *   · It has to work with no connection at all — which is precisely when a
 *     baker most wants to check whether the last twenty minutes of work landed.
 *
 * So the log is written here, as each job is filed, and scoped to the token
 * that filed it. Signing out and back in starts a new one, which is what "the
 * current logged in session" means.
 */
import { getToken, decodeJwt } from '@/lib/auth';

const PREFIX = 'autostock_shift_log:';
/** Entries beyond this are dropped oldest-first — a shift is not a ledger. */
const MAX_ENTRIES = 200;

export type ShiftJobKind = 'CONSUMPTION' | 'GOODS_IN' | 'STOCK_TAKE' | 'WASTAGE';

export interface ShiftEntry {
  id: string;
  kind: ShiftJobKind;
  /** What was filed, in the baker's words. */
  label: string;
  /** Extra context — the venue, the cake, the count. */
  detail?: string;
  at: number;
  /** 'sent' reached the server; 'queued' is waiting for a connection. */
  status: 'sent' | 'queued';
}

export const JOB_LABELS: Record<ShiftJobKind, string> = {
  CONSUMPTION: 'End of bake',
  GOODS_IN: 'Goods in',
  STOCK_TAKE: 'Stock take',
  WASTAGE: 'Wastage',
};

/**
 * The key for the CURRENT login.
 *
 * Derived from the token's issued-at and subject rather than the token itself:
 * a whole JWT in a localStorage key is a credential written somewhere it does
 * not need to be, and `iat` + `userId` already changes on every sign-in.
 *
 * Null when nobody is signed in — callers then neither read nor write, so a
 * signed-out screen shows nothing rather than the last person's shift.
 */
export function currentShiftKey(): string | null {
  const token = getToken();
  if (!token) return null;
  const claims = decodeJwt(token) as { iat?: number; userId?: string } | null;
  if (!claims) return null;
  return `${PREFIX}${claims.userId ?? 'unknown'}:${claims.iat ?? 0}`;
}

function read(key: string): ShiftEntry[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ShiftEntry[]) : [];
  } catch {
    // A corrupt or unavailable store must not take the screen down — an empty
    // shift reads as "nothing yet", which is recoverable; a crash is not.
    return [];
  }
}

/** Everything filed since this sign-in, newest first. */
export function listShift(): ShiftEntry[] {
  const key = currentShiftKey();
  if (!key) return [];
  return read(key).sort((a, b) => b.at - a.at);
}

/**
 * Record one filed job.
 *
 * Called after the submit resolves, with whatever it resolved to — a queued
 * job is recorded as queued rather than dropped, because "did that save?" is
 * the question this page exists to answer and the honest answer offline is
 * "not yet".
 */
export function recordShiftEntry(entry: Omit<ShiftEntry, 'id' | 'at'> & { at?: number }): void {
  const key = currentShiftKey();
  if (!key) return;
  const next: ShiftEntry = {
    ...entry,
    at: entry.at ?? Date.now(),
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  const all = [...read(key), next].slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(key, JSON.stringify(all));
    pruneOtherShifts(key);
  } catch {
    // Out of quota, or storage disabled. The job itself is already filed; the
    // log is a convenience and must never fail the submit.
  }
}

/**
 * Drop every other sign-in's log.
 *
 * Without this a shared iPad accumulates one key per PIN tap forever, and the
 * oldest of them is a record of who did what — kept on a device in a venue,
 * for no reason anybody asked for.
 */
function pruneOtherShifts(keep: string): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && k !== keep) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    // Nothing to do — see above.
  }
}
