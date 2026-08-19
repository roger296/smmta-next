/**
 * Persist unfinished venue work across an accidental reload (Aug-2026, A-5).
 *
 * "Lack of visual feedback on screen exits leaves users uncertain whether
 * inputs are saved, deleted, or processed."
 *
 * A half-entered delivery lived only in React state, so a stray reload, a
 * back-swipe or an iPad reclaiming memory took it silently. This stores the
 * working list in the same localStorage layer as the offline queue.
 *
 * **Scoped per site AND per screen.** A draft restored at the wrong venue is a
 * worse bug than a lost one — it would present someone else's delivery as
 * theirs, on the very screen whose venue confusion caused E-1.
 */
const PREFIX = 'autostock_draft';

export function draftKey(screen: string, siteId: string | null): string {
  return `${PREFIX}:${screen}:${siteId ?? 'no-site'}`;
}

export interface StoredDraft<T> {
  savedAt: number;
  value: T;
}

export function saveDraft<T>(screen: string, siteId: string | null, value: T): void {
  try {
    const payload: StoredDraft<T> = { savedAt: Date.now(), value };
    localStorage.setItem(draftKey(screen, siteId), JSON.stringify(payload));
  } catch {
    // Storage full / unavailable. A lost draft is bad; a crashed screen is
    // worse, and the work is still on screen either way.
  }
}

export function loadDraft<T>(screen: string, siteId: string | null): StoredDraft<T> | null {
  try {
    const raw = localStorage.getItem(draftKey(screen, siteId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft<T>;
    if (!parsed || typeof parsed.savedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(screen: string, siteId: string | null): void {
  try {
    localStorage.removeItem(draftKey(screen, siteId));
  } catch {
    // nothing to do
  }
}
