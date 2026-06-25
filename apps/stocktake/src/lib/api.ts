import type { CountEntry, CountsMap, Session } from './types';

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

function url(path: string): string {
  return `${API_BASE}/api/v1/stocktake-lite${path}`;
}

function headers(code: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'x-stocktake-code': code };
}

/** Entries that need pushing: counted and not yet synced. A cleared entry
 *  (counted=false) is held locally and simply not sent. */
export function dirtyCounted(counts: CountsMap): CountEntry[] {
  return Object.values(counts).filter((c) => c.dirty && c.counted);
}

export interface SyncResult {
  ok: boolean;
  synced: number;
}

/** Push the device's outstanding counts. The server upserts idempotently, so a
 *  retry of the same batch is safe. Returns ok=false (without throwing) when
 *  offline / the request fails — the caller keeps the entries dirty. */
export async function pushCounts(session: Session, entries: CountEntry[]): Promise<SyncResult> {
  if (entries.length === 0) return { ok: true, synced: 0 };
  try {
    const res = await fetch(url('/sync'), {
      method: 'POST',
      headers: headers(session.accessCode),
      body: JSON.stringify({
        period: session.period,
        siteSlug: session.siteSlug,
        deviceId: session.deviceId,
        counterName: session.counterName,
        counts: entries.map((e) => ({
          itemKey: e.itemKey,
          itemName: e.itemName,
          section: e.section,
          packSize: e.packSize,
          quantity: e.quantity,
          isCustom: e.isCustom,
        })),
      }),
    });
    if (!res.ok) return { ok: false, synced: 0 };
    const json = (await res.json()) as { success: boolean; data?: { synced: number } };
    return { ok: json.success, synced: json.data?.synced ?? 0 };
  } catch {
    return { ok: false, synced: 0 };
  }
}

// ── Head-office consolidation surface ────────────────────────────────────

export interface Contributor {
  deviceId: string;
  counterName: string;
  quantity: number;
  countedAt: string;
}

export interface ConsolidatedItem {
  groupKey: string;
  itemKey: string;
  itemName: string;
  section: string | null;
  packSize: string | null;
  isCustom: boolean;
  status: 'RESOLVED' | 'CONFLICT';
  quantity: number | null;
  resolvedBy?: string | null;
  contributors: Contributor[];
}

export interface SiteConsolidation {
  period: string;
  siteSlug: string;
  itemCount: number;
  resolvedCount: number;
  conflictCount: number;
  contributorNames: string[];
  items: ConsolidatedItem[];
}

export interface SiteSummary {
  siteSlug: string;
  itemCount: number;
  conflictCount: number;
  counters: string[];
}

export async function fetchSites(code: string, period: string): Promise<SiteSummary[]> {
  const res = await fetch(url(`/sites?period=${encodeURIComponent(period)}`), { headers: headers(code) });
  if (!res.ok) throw new Error('Failed to load sites');
  const json = (await res.json()) as { data: SiteSummary[] };
  return json.data;
}

export async function fetchConsolidation(
  code: string,
  period: string,
  site: string,
): Promise<SiteConsolidation> {
  const res = await fetch(
    url(`/consolidate?period=${encodeURIComponent(period)}&site=${encodeURIComponent(site)}`),
    { headers: headers(code) },
  );
  if (!res.ok) throw new Error('Failed to load consolidation');
  const json = (await res.json()) as { data: SiteConsolidation };
  return json.data;
}

export async function resolveConflict(
  code: string,
  body: { period: string; siteSlug: string; groupKey: string; resolvedQty: number; resolvedBy?: string },
): Promise<void> {
  const res = await fetch(url('/resolve'), {
    method: 'POST',
    headers: headers(code),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to resolve');
}

export function exportCsvUrl(period: string, site?: string): string {
  const q = site
    ? `period=${encodeURIComponent(period)}&site=${encodeURIComponent(site)}`
    : `period=${encodeURIComponent(period)}`;
  return url(`/export.csv?${q}`);
}
