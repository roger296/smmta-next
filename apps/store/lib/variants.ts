/**
 * Variant-picking helpers shared between the PDP page (server component)
 * and the swatch picker (client component).
 *
 * `pickDefaultVariant` chooses the variant to show first when no explicit
 * `?colour=` is on the URL. We prefer the first in-stock variant —
 * defaulting to an out-of-stock SKU when buyable colours exist makes the
 * catalogue look thinner than it is and pushes the customer toward a
 * notify-me flow they'd skip if shown a buyable product. Falls back to
 * `variants[0]` only when every variant is out of stock.
 *
 * Tiebreaker: input order. Callers are expected to pass variants already
 * sorted by `sortOrderInGroup` / colour name (which is what the API
 * does). The helper does not re-sort.
 */
import { effectiveStockState } from './dispatch-copy';
import type { StockState } from './api-types';

export interface PickableVariant {
  id: string;
  colour: string | null;
  availableQty: number;
  stockState?: StockState;
}

/**
 * Default-variant preference, in order:
 *   1. First variant with `stockState === 'IN_STOCK'` (warehouse-fulfilled,
 *      ships within 1 day — shortest path to a buyable product).
 *   2. First variant with `stockState === 'AVAILABLE_FROM_SUPPLIER'`
 *      (drop-ship, 2 working days).
 *   3. Alphabetical / input-order fallback when every variant is OOS.
 */
export function pickDefaultVariant<T extends PickableVariant>(variants: T[]): T | undefined {
  if (variants.length === 0) return undefined;
  const inStock = variants.find((v) => effectiveStockState(v) === 'IN_STOCK');
  if (inStock) return inStock;
  const supplier = variants.find((v) => effectiveStockState(v) === 'AVAILABLE_FROM_SUPPLIER');
  if (supplier) return supplier;
  return variants[0];
}

/**
 * Resolve the variant the page should render given an optional `?colour=`
 * query value. Explicit colour matches take precedence — if the customer
 * deep-linked to a specific SKU, we honour their request even if it's out
 * of stock. Only the no-colour path uses the in-stock-default behaviour.
 */
export function resolveInitialVariant<T extends PickableVariant>(
  variants: T[],
  queriedColour: string | null | undefined,
): T | undefined {
  if (queriedColour) {
    const requested = variants.find(
      (v) => v.colour && v.colour.toLowerCase() === queriedColour.toLowerCase(),
    );
    if (requested) return requested;
  }
  return pickDefaultVariant(variants);
}
