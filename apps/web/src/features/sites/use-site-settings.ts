/**
 * Per-site settings the venue screens need (Aug-2026 feedback set, F-7).
 *
 * Today that is `benchesPerTable`: "Request to show benches under the kilo
 * figures." Bakers set up and count in benches; the recipe and the session are
 * in tables. The ratio is per-site because the rooms differ.
 *
 * `null` means "not set for this site", which the screen says out loud rather
 * than quietly assuming a number (setting them is human task 5).
 */
import { useSiteContext } from './site-context';

export interface SiteSettings {
  benchesPerTable: number | null;
}

export function useSiteSettings(): SiteSettings {
  const { selectedSite } = useSiteContext();
  const raw = (selectedSite as { benchesPerTable?: string | null } | null)?.benchesPerTable;
  const parsed = raw == null ? NaN : Number(raw);
  return {
    benchesPerTable: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
  };
}
