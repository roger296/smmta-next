import * as React from 'react';
import { getToken, decodeJwt } from '@/lib/auth';
import { getDeviceSite } from './device-site';
import { useSites, type Site } from './use-sites';

const STORAGE_KEY = 'autostock_selected_site';

/** How the current site was arrived at — see `SiteProvider` (defect E-1). */
export type SiteSource = 'device' | 'user' | 'stored' | 'default' | 'none';

interface SiteContextValue {
  sites: Site[];
  isLoading: boolean;
  selectedSiteId: string | null;
  selectedSite: Site | null;
  setSelectedSiteId: (id: string) => void;
  /** Where the selection came from. */
  source: SiteSource;
  /**
   * True when the site is bound to this device (or explicitly chosen), false
   * when it was defaulted. A defaulted site is shown in `warn` styling reading
   * "not set for this device", because a silent alphabetical default is
   * exactly how a South London iPad booked 100 kg to Birmingham.
   */
  isBound: boolean;
}

const SiteContext = React.createContext<SiteContextValue | null>(null);

/** The site this device's PIN is bound to, from the JWT or the device store. */
export function readDeviceBoundSiteId(): string | null {
  const token = getToken();
  const fromToken = token ? (decodeJwt(token) as { siteId?: string | null } | null)?.siteId : null;
  if (fromToken) return fromToken;
  return getDeviceSite()?.siteId ?? null;
}

/**
 * Holds the currently-selected site, shared across the stock screens
 * (P2, spec §A5).
 *
 * ── Defect E-1, and why the precedence below is in this order ───────────────
 *
 * `POST /auth/pin-login` returns the `siteId` the PIN is scoped to and embeds
 * it in the JWT. The PIN screen read only the token and discarded the rest, so
 * this provider fell straight through to "first active site by name" — which,
 * of the five seeded sites, is **Birmingham**. A venue iPad in South London
 * booked 100 kg to Birmingham, silently.
 *
 * Precedence, highest first:
 *
 *   1. **device** — the site bound to this PIN / device. It wins over
 *      everything: the device knows where it physically is, and no stale
 *      localStorage entry should be able to override that.
 *   2. **user** — an explicit in-session choice. Someone deliberately
 *      switching site means it.
 *   3. **stored** — the last explicit choice, from localStorage.
 *   4. **default** — first active site. Reached only when nothing above
 *      applies, and flagged `isBound: false` so the UI SAYS it is a guess.
 */
export function SiteProvider({ children }: { children: React.ReactNode }) {
  const { data: sites = [], isLoading } = useSites();
  const deviceSiteId = React.useMemo(() => readDeviceBoundSiteId(), []);

  const [userChoice, setUserChoice] = React.useState<string | null>(null);
  const [storedChoice, setStoredChoice] = React.useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const setSelectedSiteId = React.useCallback((id: string) => {
    setUserChoice(id);
    setStoredChoice(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage unavailable — keep the in-memory selection only.
    }
  }, []);

  const known = (id: string | null | undefined): boolean =>
    !!id && sites.some((s) => s.id === id);

  // Resolve, in precedence order. `sites` being empty means we cannot validate
  // anything yet, so nothing is chosen — better a blank venue chip for a
  // moment than a confidently wrong one.
  let selectedSiteId: string | null = null;
  let source: SiteSource = 'none';
  if (known(deviceSiteId)) {
    selectedSiteId = deviceSiteId;
    source = 'device';
  } else if (known(userChoice)) {
    selectedSiteId = userChoice;
    source = 'user';
  } else if (known(storedChoice)) {
    selectedSiteId = storedChoice;
    source = 'stored';
  } else if (sites.length > 0) {
    const active = sites.filter((s) => s.isActive);
    const pool = active.length > 0 ? active : sites;
    selectedSiteId = pool[0]!.id;
    source = 'default';
  }

  const selectedSite = sites.find((s) => s.id === selectedSiteId) ?? null;

  const value: SiteContextValue = {
    sites,
    isLoading,
    selectedSiteId,
    selectedSite,
    setSelectedSiteId,
    source,
    // A defaulted site is NOT bound. Everything else was either chosen by the
    // device or chosen by a person.
    isBound: source === 'device' || source === 'user' || source === 'stored',
  };

  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

export function useSiteContext(): SiteContextValue {
  const ctx = React.useContext(SiteContext);
  if (!ctx) {
    throw new Error('useSiteContext must be used within a SiteProvider');
  }
  return ctx;
}
