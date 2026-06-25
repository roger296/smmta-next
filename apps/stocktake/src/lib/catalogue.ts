import raw from '../data/catalogue.json';
import type { Catalogue, CatalogueItem } from './types';

export const catalogue = raw as unknown as Catalogue;

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
