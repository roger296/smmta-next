import type { CountEntry, CountsMap, Session } from './types';

const SESSION_KEY = 'stocktake_session';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

/** Counts are scoped per period+site so one iPad could (in theory) hold more
 *  than one site's progress without clashing. */
function countsKey(period: string, siteSlug: string): string {
  return `stocktake_counts_${period}_${siteSlug}`;
}

export function loadCounts(period: string, siteSlug: string): CountsMap {
  try {
    const raw = localStorage.getItem(countsKey(period, siteSlug));
    return raw ? (JSON.parse(raw) as CountsMap) : {};
  } catch {
    return {};
  }
}

export function saveCounts(period: string, siteSlug: string, counts: CountsMap): void {
  try {
    localStorage.setItem(countsKey(period, siteSlug), JSON.stringify(counts));
  } catch {
    // storage full / unavailable — best-effort; the next save retries
  }
}

export function newDeviceId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `dev-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** Build/replace a count entry. Setting a value (incl. 0) marks it counted +
 *  dirty so the next sync pushes it. */
export function setCount(
  counts: CountsMap,
  base: Omit<CountEntry, 'quantity' | 'counted' | 'dirty' | 'countedAt'>,
  quantity: number,
): CountsMap {
  return {
    ...counts,
    [base.itemKey]: {
      ...base,
      quantity,
      counted: true,
      dirty: true,
      countedAt: new Date().toISOString(),
    },
  };
}

/** Clear a count back to not-counted (and mark dirty so the server learns it). */
export function clearCount(counts: CountsMap, itemKey: string): CountsMap {
  const existing = counts[itemKey];
  if (!existing) return counts;
  return {
    ...counts,
    [itemKey]: { ...existing, quantity: 0, counted: false, dirty: true },
  };
}
