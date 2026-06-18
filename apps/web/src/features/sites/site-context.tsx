import * as React from 'react';
import { useSites, type Site } from './use-sites';

const STORAGE_KEY = 'autostock_selected_site';

interface SiteContextValue {
  sites: Site[];
  isLoading: boolean;
  selectedSiteId: string | null;
  selectedSite: Site | null;
  setSelectedSiteId: (id: string) => void;
}

const SiteContext = React.createContext<SiteContextValue | null>(null);

/**
 * Holds the operator's currently-selected site, persisted to localStorage and
 * shared across the stock screens (P2, spec §A5). Defaults to the first active
 * site once the list loads.
 */
export function SiteProvider({ children }: { children: React.ReactNode }) {
  const { data: sites = [], isLoading } = useSites();
  const [selectedSiteId, setSelectedSiteIdState] = React.useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const setSelectedSiteId = React.useCallback((id: string) => {
    setSelectedSiteIdState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage unavailable — keep the in-memory selection only.
    }
  }, []);

  // Default / heal the selection once sites load: if nothing is selected, or
  // the stored id is no longer a known active site, pick the first active one.
  React.useEffect(() => {
    if (sites.length === 0) return;
    const active = sites.filter((s) => s.isActive);
    const pool = active.length > 0 ? active : sites;
    const valid = selectedSiteId && pool.some((s) => s.id === selectedSiteId);
    if (!valid) {
      setSelectedSiteId(pool[0]!.id);
    }
  }, [sites, selectedSiteId, setSelectedSiteId]);

  const selectedSite = sites.find((s) => s.id === selectedSiteId) ?? null;

  const value: SiteContextValue = {
    sites,
    isLoading,
    selectedSiteId,
    selectedSite,
    setSelectedSiteId,
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
