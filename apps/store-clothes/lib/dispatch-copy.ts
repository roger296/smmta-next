/**
 * Customer-facing dispatch copy keyed by stock state.
 *
 * Lives separately from the components that render it so future tweaks
 * (per-supplier SLA accuracy, copy A/B tests, brand re-skin) are a
 * single-file change. Per the spec §C, only the copy differs by state
 * — the badge colour rule is "two greens, no amber" and lives on the
 * swatch component.
 */
import type { StockState } from './api-types';

export interface DispatchCopy {
  /** Pill / flag label inside the swatch. Short — must fit. */
  badgeLabel: string;
  /** Sentence rendered next to the price on the PDP main panel. */
  primary: string;
}

export const DISPATCH_COPY: Record<StockState, DispatchCopy> = {
  // Same-day dispatch on working days for orders placed before 14:00 UK
  // time (Roger, 2026-09-14). Supplier orders are sent within a minute of
  // payment, so this holds while the suppliers' own cut-offs are 14:00 or later.
  IN_STOCK: {
    badgeLabel: 'In stock',
    primary: 'Order by 2pm (UK time) on a working day and it ships the same day.',
  },
  AVAILABLE_FROM_SUPPLIER: {
    badgeLabel: 'Available from supplier',
    primary: 'Order by 2pm (UK time) on a working day and it ships the same day from our supplier partner.',
  },
  OUT_OF_STOCK: {
    badgeLabel: 'Out of stock',
    primary: 'Notify me when this item is back in stock.',
  },
};

/** Resolve the state for a variant, falling back to `availableQty > 0`
 *  when the API response is from a deployment that pre-dates §C. */
export function effectiveStockState(variant: {
  stockState?: StockState;
  availableQty?: number;
}): StockState {
  if (variant.stockState) return variant.stockState;
  if ((variant.availableQty ?? 0) > 0) return 'IN_STOCK';
  return 'OUT_OF_STOCK';
}

/** Both green states are "the customer can buy this". Used to enable
 *  the Add-to-cart button. */
export function isSellable(state: StockState): boolean {
  return state === 'IN_STOCK' || state === 'AVAILABLE_FROM_SUPPLIER';
}
