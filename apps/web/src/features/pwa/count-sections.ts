/**
 * Splitting the count sheet into Item Category sections (Sept-2026 request).
 *
 * A full count at a venue is ~400 lines in one flat list. Grouping it by the
 * operator's own Item Category means a counter working the dry store can see
 * the dry store, and can fold away the bar and the stationery they are not
 * holding a clipboard in front of.
 *
 * ⚠️ Collapsing a section HIDES it, it does not exclude it. Counts already
 * entered in a folded section are still submitted, and the section still
 * reports its own progress in its header — otherwise folding for clarity would
 * quietly drop somebody's work, which is the worst thing this screen could do.
 */

/** The minimum a line needs for grouping; the real line carries far more. */
export interface SectionableLine {
  productId: string;
  itemCategoryName?: string | null;
}

/** Shown for lines whose product has no Item Category set. */
export const UNCATEGORISED = 'Uncategorised';

export interface CountSection<T> {
  /** Display name; also the key used for collapse state. */
  name: string;
  lines: T[];
  /** How many of this section's lines have a count entered. */
  counted: number;
  total: number;
}

/**
 * Group lines into sections, named categories first (A→Z), Uncategorised last.
 *
 * Uncategorised sorts last rather than alphabetically because it is a residue,
 * not a category — it belongs at the bottom of the sheet with the odds and
 * ends, not between "Bar" and "Cleaning".
 */
export function groupByCategory<T extends SectionableLine>(
  lines: readonly T[],
  isCounted: (line: T) => boolean,
): CountSection<T>[] {
  const byName = new Map<string, T[]>();
  for (const line of lines) {
    const name = (line.itemCategoryName ?? '').trim() || UNCATEGORISED;
    const bucket = byName.get(name);
    if (bucket) bucket.push(line);
    else byName.set(name, [line]);
  }

  return [...byName.entries()]
    .map(([name, sectionLines]) => ({
      name,
      lines: sectionLines,
      counted: sectionLines.filter(isCounted).length,
      total: sectionLines.length,
    }))
    .sort((a, b) => {
      if (a.name === UNCATEGORISED) return 1;
      if (b.name === UNCATEGORISED) return -1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Is this section folded away?
 *
 * A section is open unless it has been explicitly collapsed. The alternative —
 * remembering which are open — means a category added later arrives collapsed
 * and invisible, and a counter has no reason to suspect it exists.
 */
export function isCollapsed(collapsed: readonly string[], name: string): boolean {
  return collapsed.includes(name);
}

export function toggleCollapsed(collapsed: readonly string[], name: string): string[] {
  return collapsed.includes(name)
    ? collapsed.filter((n) => n !== name)
    : [...collapsed, name];
}

const STORAGE_KEY = 'autostock.stock-take.collapsed-sections';

/**
 * Which sections this device has folded away.
 *
 * Held on the DEVICE, not the account: venue iPads are shared, and the useful
 * thing to remember is "this iPad is being used for the dry store", not "this
 * person once collapsed the bar". Every accessor is guarded — a locked-down
 * iPad with site data blocked throws on localStorage, and a count sheet must
 * not fail to render over a view preference.
 */
export function loadCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function saveCollapsed(names: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // A view preference is not worth failing the screen for.
  }
}
