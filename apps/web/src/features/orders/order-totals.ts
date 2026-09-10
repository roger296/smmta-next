/**
 * How an order's stored totals relate to tax, and what to call them.
 *
 * The same columns mean different things depending on how the order was made:
 *
 *   - Storefront orders store goods and delivery INCLUDING VAT, and the tax
 *     total is the VAT already inside them: total = goods + delivery.
 *   - Orders created in the admin store goods EXCLUDING VAT and add tax on top,
 *     with no tax applied to delivery: total = goods + tax + delivery.
 *
 * Labelling every order "inc Tax" would put a false label on the second kind.
 * Nothing on the order reliably says which it is — the storefront leaves the
 * `taxInclusive` flag at its default of false, and `sourceChannel` describes
 * where an order came from, not how its prices were entered — so this reads
 * the arithmetic instead. The figures describe themselves, whatever created
 * them.
 */

export interface OrderTotalsInput {
  orderTotal: string | number | null | undefined;
  taxTotal: string | number | null | undefined;
  deliveryCharge: string | number | null | undefined;
  grandTotal: string | number | null | undefined;
}

/** Stored figures are rounded to the penny independently, so allow 1p. */
const TOLERANCE_PENCE = 1;

function pence(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * True when goods and delivery already include the tax total. When the tax
 * total is zero both readings agree, so this returns true and the label is
 * accurate either way.
 */
export function totalsIncludeTax(order: OrderTotalsInput): boolean {
  const goods = pence(order.orderTotal);
  const delivery = pence(order.deliveryCharge);
  const grand = pence(order.grandTotal);
  const tax = pence(order.taxTotal);
  const inclusiveGap = Math.abs(grand - (goods + delivery));
  const exclusiveGap = Math.abs(grand - (goods + tax + delivery));
  if (inclusiveGap <= TOLERANCE_PENCE) return true;
  if (exclusiveGap <= TOLERANCE_PENCE) return false;
  // Neither identity holds — the figures do not reconcile. Choose whichever
  // is closer rather than asserting a tax treatment the numbers do not show.
  return inclusiveGap <= exclusiveGap;
}

/** Tile titles for the order summary, true to how the figures were stored. */
export function orderTotalLabels(order: OrderTotalsInput): { goods: string; delivery: string } {
  return totalsIncludeTax(order)
    ? { goods: 'Goods Total (inc Tax)', delivery: 'Delivery (inc Tax)' }
    : // Admin orders add tax to goods only, never to delivery, so the delivery
      // figure makes no tax claim either way.
      { goods: 'Goods Total (ex Tax)', delivery: 'Delivery' };
}
