import raw from '../data/catalogue.json';
import { fetchCatalogue } from './api';
import type { Catalogue, CatalogueItem } from './types';

/**
 * The bundled June-2026 sheet. No longer the source of truth — it is the
 * last-resort fallback for a device that has never once been online, so a
 * brand-new iPad in a basement stockroom can still count something.
 */
export const catalogue = raw as unknown as Catalogue;

const CACHE_KEY = 'stocktake.catalogue.v1';

/**
 * The count sheet, freshest-first: live from the product catalogue, else the
 * last copy this device saw, else the bundle.
 *
 * Counting happens in stockrooms with patchy signal, so a failed fetch must
 * never block a count — but the list must also follow the database rather than
 * whatever was baked in at build time, which is why the live copy is written
 * to the cache on every success.
 */
export async function loadCatalogue(
  accessCode: string,
): Promise<{ items: CatalogueItem[]; source: 'live' | 'cache' | 'bundled' }> {
  try {
    const items = await fetchCatalogue(accessCode);
    if (items.length > 0) {
      localStorage.setItem(CACHE_KEY, JSON.stringify(items));
      return { items, source: 'live' };
    }
  } catch {
    // Offline, or the access code was rejected — fall through to the cache.
  }
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const items = JSON.parse(cached) as CatalogueItem[];
      if (items.length > 0) return { items, source: 'cache' };
    } catch {
      // Corrupt cache is no better than none.
    }
  }
  return { items: catalogue.items, source: 'bundled' };
}

/** The current stock-take period. Bumped each quarter. */
export const PERIOD = 'JUNE-2026';

/** The six Big Bakes sites (slugs aligned with the canonical sites table). */
export const SITES = [
  { slug: 'birmingham', name: 'Birmingham' },
  { slug: 'liverpool', name: 'Liverpool' },
  { slug: 'london-east', name: 'London East' },
  { slug: 'london-south', name: 'London South' },
  { slug: 'manchester', name: 'Manchester' },
  { slug: 'dallas', name: 'Dallas (US)' },
];

export interface SectionGroup {
  area: string | null;
  section: string | null;
  /** Stable id for jump navigation. */
  id: string;
  items: CatalogueItem[];
}

/** Group the flat catalogue into area → section blocks, preserving sheet order. */
export function groupCatalogue(items: CatalogueItem[]): SectionGroup[] {
  const groups: SectionGroup[] = [];
  let current: SectionGroup | null = null;
  for (const item of items) {
    const key = `${item.area ?? ''}__${item.section ?? ''}`;
    if (!current || `${current.area ?? ''}__${current.section ?? ''}` !== key) {
      current = {
        area: item.area,
        section: item.section,
        id: `sec-${groups.length}`,
        items: [],
      };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}
