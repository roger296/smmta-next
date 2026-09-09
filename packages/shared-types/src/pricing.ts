/**
 * Volume pricing.
 *
 * A spool's price slides with the size of the order: one roll costs the
 * product's max price, ten or more cost its min price, and the quantities in
 * between are spread evenly across that range. The discount applies to the
 * whole basket, so adding a tenth roll of any colour re-prices the nine
 * already in it.
 *
 * THIS MODULE IS THE ONLY PLACE THAT DECIDES A UNIT PRICE. Two independent
 * code paths have to agree on the number to the penny:
 *
 *   - the storefront, which totals the cart and hands that figure to Mollie
 *     (apps/store/lib/checkout.ts), and
 *   - the API, which recomputes the order from scratch on commit and refuses
 *     the order if its total differs from what Mollie took by more than a
 *     penny (apps/api/src/modules/storefront/order-commit.service.ts).
 *
 * If those two ever disagree, every affected checkout fails that guard — or,
 * worse, a looser guard would let us charge one amount and record another. So
 * both import this function rather than reimplementing the arithmetic. It is
 * deliberately pure, integer-only, and free of any database or environment access.
 */

/** Quantity at which the min price is reached. Below this the price slides. */
export const VOLUME_PRICE_BEST_QTY = 10;

/**
 * Unit price in pence for a given basket size.
 *
 * @param minPence  Price per unit at VOLUME_PRICE_BEST_QTY or above.
 * @param maxPence  Price per unit for a single unit. Null/absent, or not
 *                  greater than the min, means this product does not slide —
 *                  it stays at its min price, which is how every product
 *                  behaved before volume pricing existed.
 * @param totalBasketQty Total units across the WHOLE basket, not just this line.
 *
 * Rounding is applied once, to the cumulative discount rather than per step,
 * so the result is a pure function of the inputs and cannot drift between the
 * two call sites.
 */
export function tieredUnitPricePence(
  minPence: number,
  maxPence: number | null | undefined,
  totalBasketQty: number,
): number {
  if (!Number.isFinite(minPence)) {
    throw new Error(`tieredUnitPricePence: minPence must be a number, got ${minPence}`);
  }
  // No usable ceiling: the product does not slide. Covers null (never priced),
  // equal min/max (the state every product was in before this feature), and
  // inverted data, which should not silently produce a discount off the min.
  if (maxPence == null || !Number.isFinite(maxPence) || maxPence <= minPence) {
    return Math.round(minPence);
  }

  const qty = Math.max(1, Math.min(VOLUME_PRICE_BEST_QTY, Math.floor(totalBasketQty)));
  const spread = maxPence - minPence;
  // (qty - 1) steps of the range, divided into (BEST_QTY - 1) equal parts, so
  // qty 1 pays the max exactly and qty BEST_QTY pays the min exactly.
  const discount = Math.round((spread * (qty - 1)) / (VOLUME_PRICE_BEST_QTY - 1));
  return maxPence - discount;
}

/**
 * The price band to advertise for a product, ignoring what is in the basket.
 * Returns equal values when the product does not slide, which callers can use
 * to decide whether to show a range at all.
 */
export function priceBandPence(
  minPence: number,
  maxPence: number | null | undefined,
): { fromPence: number; toPence: number; slides: boolean } {
  const single = tieredUnitPricePence(minPence, maxPence, 1);
  const best = tieredUnitPricePence(minPence, maxPence, VOLUME_PRICE_BEST_QTY);
  return { fromPence: best, toPence: single, slides: single > best };
}
