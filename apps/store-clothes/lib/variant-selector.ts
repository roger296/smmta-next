/**
 * Multi-axis variant resolver for the Clothes Shop.
 *
 * Given the group's `attributeAxes` (e.g. ['size', 'colour']) and the
 * array of variants (each with an `attributes` object), the selector
 * lets the customer pick one value per axis and resolves to the
 * matching variant — or to "no matching combination" when no variant
 * has that exact attribute set.
 *
 * The resolver is pure: state is owned by the React component; this
 * file is just helpers.
 */
import type { FullVariant } from './api-types';
import { effectiveStockState, isSellable } from './dispatch-copy';
import { compareSizes } from './sizes';

export interface AxisValueOption {
  value: string;
  /** True when at least one variant exists with this value at this axis. */
  exists: boolean;
  /** True when at least one variant with this value is sellable. */
  hasStock: boolean;
}

/** All distinct values for one axis, with stock-availability flags. */
export function listAxisValues(axis: string, variants: FullVariant[]): AxisValueOption[] {
  const map = new Map<string, AxisValueOption>();
  for (const v of variants) {
    const value = (v.attributes ?? {})[axis];
    if (!value) continue;
    const sellable =
      v.stockState === 'IN_STOCK' || v.stockState === 'AVAILABLE_FROM_SUPPLIER';
    const existing = map.get(value);
    if (existing) {
      existing.hasStock = existing.hasStock || sellable;
    } else {
      map.set(value, { value, exists: true, hasStock: sellable });
    }
  }
  return [...map.values()].sort((a, b) => sizeOrColourSort(axis, a.value, b.value));
}

/**
 * Find the variant that exactly matches the requested attribute set.
 * Returns null when no variant carries that combination — the caller
 * surfaces "out of combination" to the customer.
 */
export function resolveVariant(
  variants: FullVariant[],
  attributes: Record<string, string>,
): FullVariant | null {
  const keys = Object.keys(attributes);
  for (const v of variants) {
    const va = v.attributes ?? {};
    let match = true;
    for (const k of keys) {
      if (va[k] !== attributes[k]) {
        match = false;
        break;
      }
    }
    if (match) return v;
  }
  return null;
}

/**
 * The selection a range page opens on. Values from the address win — a
 * category page filtered to one colour links with `?colour=` — and the other
 * axes are filled from a variant that has those values, preferring one that
 * can be bought. So a link to Black opens on a size Black comes in, rather
 * than on the first variant's size.
 */
export function initialSelection(
  axes: string[],
  variants: FullVariant[],
  fromQuery: Record<string, string>,
): Record<string, string> {
  const fits = (v: FullVariant) =>
    Object.entries(fromQuery).every(([axis, value]) => v.attributes?.[axis] === value);
  const sellable = (v: FullVariant) => isSellable(effectiveStockState(v));
  const withAttributes = variants.filter((v) => v.attributes);
  const seed =
    withAttributes.find((v) => fits(v) && sellable(v)) ??
    withAttributes.find(fits) ??
    withAttributes.find(sellable) ??
    variants[0];
  const selection: Record<string, string> = { ...(seed?.attributes ?? {}) };
  for (const axis of axes) {
    if (fromQuery[axis]) selection[axis] = fromQuery[axis]!;
  }
  return selection;
}

/** Size axis in size order (XS, S, M … 5XL); anything else alphabetical. */
function sizeOrColourSort(axis: string, a: string, b: string): number {
  if (axis === 'size') return compareSizes(a, b);
  return a.localeCompare(b);
}
