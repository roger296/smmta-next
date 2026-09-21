/**
 * Which order events should buy a shipping label.
 *
 *   - `order.paid` from a storefront: the customer has paid, so ship. Other
 *     payments (a pre-order deposit, say) also emit order.paid but ship later.
 *   - `order.allocated`, when SHIPPING_LABEL_ON_ALLOCATION is on: every line
 *     has stock, so the order is ready to pick and the label can print with
 *     the pick note. This is the route for orders that arrive by file or API
 *     feed and are never "paid" here.
 *
 *   - `order.released`, on the same setting: an order allocated while on hold
 *     was refused its label then, so it is asked for again when the hold lifts.
 *     The handler checks the order really is fully allocated.
 *
 * Kept apart from the worker so the rule can be tested without a queue.
 */
export function labelWantedFor(
  eventType: string,
  source: string | undefined,
  labelOnAllocation: boolean,
): boolean {
  if (eventType === 'order.paid') return source === 'storefront';
  if (eventType === 'order.allocated') return labelOnAllocation;
  // A released order that was allocated while held missed its order.allocated label.
  if (eventType === 'order.released') return labelOnAllocation;
  return false;
}
