/**
 * Several counters, one take (Sept 2026).
 *
 * Two people count the same venue at once, on two iPads, each signed in as
 * themselves. Each screen shows three kinds of number, and must never confuse
 * them:
 *
 *   - PENDING  typed on this iPad, not yet sent. Only this iPad knows it.
 *   - QUEUED   sent while offline; sitting in the device queue. The server has
 *              not got it yet, so nobody else can see it either.
 *   - SAVED    on the server, visible to every counter, with WHO saved it.
 *
 * What this device has in hand wins on screen (pending, then queued), because
 * that is the number the person holding it just entered. Everything else comes
 * from the server and is labelled with its counter's name — "you" for your own.
 *
 * Kept free of React so the rules can be tested without rendering a screen.
 */

/** The fields of a server take line this module reads. */
export interface SharedLine {
  productId: string;
  countedQty?: string | null;
  countedByUserId?: string | null;
  countedByName?: string | null;
  countedAt?: string | null;
}

export type CountSource = 'pending' | 'queued' | 'saved' | 'none';

export interface RowCount {
  counted: boolean;
  qty: number;
  source: CountSource;
  /** Who saved the server's number (source 'saved'). */
  byName?: string | null;
  mine?: boolean;
  at?: string | null;
}

export type CountMap = Record<string, number>;

/** What one row shows, from the three sources in order of precedence. */
export function rowCount(
  line: SharedLine,
  pending: CountMap,
  queued: CountMap,
  meId: string | null,
): RowCount {
  if (pending[line.productId] !== undefined) {
    return { counted: true, qty: pending[line.productId]!, source: 'pending' };
  }
  if (queued[line.productId] !== undefined) {
    return { counted: true, qty: queued[line.productId]!, source: 'queued' };
  }
  if (line.countedQty != null) {
    return {
      counted: true,
      qty: Number(line.countedQty),
      source: 'saved',
      byName: line.countedByName ?? null,
      mine: meId != null && line.countedByUserId === meId,
      at: line.countedAt ?? null,
    };
  }
  return { counted: false, qty: 0, source: 'none' };
}

/** "10:42", in the venue's own clock. Empty when there is no usable time. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** The line under the item name that says whose number this is. */
export function attribution(row: RowCount): string | null {
  switch (row.source) {
    case 'pending':
      return 'Not saved yet';
    case 'queued':
      return 'Waiting to send';
    case 'saved': {
      // A line saved before names were recorded has no counter; say so rather
      // than inventing one.
      const who = row.mine ? 'you' : (row.byName ?? 'someone (not recorded)');
      const when = clockTime(row.at);
      return `Saved by ${who}${when ? ` · ${when}` : ''}`;
    }
    default:
      return null;
  }
}

export interface CountConflict {
  productId: string;
  theirName: string;
  theirQty: number;
  yourQty: number;
}

/**
 * Counts about to be saved that would REPLACE a different number someone else
 * already saved on the same line.
 *
 * Saving is last-writer-wins on the server — the line holds one number — so a
 * second counter re-counting an item would silently overwrite the first
 * person's figure. This finds those so the screen can ask first. The same
 * number is not a conflict (nothing is lost), and neither is replacing your
 * own earlier count.
 */
export function conflicts(
  lines: SharedLine[],
  pending: CountMap,
  meId: string | null,
): CountConflict[] {
  const out: CountConflict[] = [];
  for (const line of lines) {
    const yours = pending[line.productId];
    if (yours === undefined || line.countedQty == null) continue;
    if (meId != null && line.countedByUserId === meId) continue;
    const theirs = Number(line.countedQty);
    if (theirs === yours) continue;
    out.push({
      productId: line.productId,
      theirName: line.countedByName ?? 'someone',
      theirQty: theirs,
      yourQty: yours,
    });
  }
  return out;
}

/**
 * Drop queued counts the server now shows as saved by THIS user with the same
 * number — they have synced, so the label should move from "Waiting to send"
 * to "Saved by you". Anything else stays queued.
 */
export function settleQueued(queued: CountMap, lines: SharedLine[], meId: string | null): CountMap {
  if (meId == null) return queued;
  const byId = new Map(lines.map((l) => [l.productId, l]));
  let changed = false;
  const next: CountMap = {};
  for (const [productId, qty] of Object.entries(queued)) {
    const line = byId.get(productId);
    if (line?.countedQty != null && line.countedByUserId === meId && Number(line.countedQty) === qty) {
      changed = true;
      continue;
    }
    next[productId] = qty;
  }
  return changed ? next : queued;
}

/** Everyone whose counts are on the take, with how many lines each, most first. */
export function countersOn(lines: SharedLine[], meId: string | null): Array<{ name: string; lines: number; mine: boolean }> {
  const tally = new Map<string, { name: string; lines: number; mine: boolean }>();
  for (const l of lines) {
    if (l.countedQty == null) continue;
    const mine = meId != null && l.countedByUserId === meId;
    const key = mine ? '#me' : (l.countedByUserId ?? `name:${l.countedByName ?? ''}`);
    const t = tally.get(key) ?? { name: mine ? 'You' : (l.countedByName ?? 'Not recorded'), lines: 0, mine };
    t.lines += 1;
    tally.set(key, t);
  }
  return [...tally.values()].sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
}
