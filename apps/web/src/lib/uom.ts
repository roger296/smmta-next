/**
 * Front-end UoM helpers for the iPad jobs (P13, spec §A3). Mirrors the
 * server-side conversion so goods-in shows a live purchase→stock figure and
 * stock-take counts can be bucketed to a quantum for fungibles.
 */
export function purchaseToStock(purchaseQty: number, factor: number): number {
  return purchaseQty * factor;
}

const DISCRETE = new Set(['each', 'ea', 'unit', 'units', 'item', 'items', 'pcs', 'piece']);

export function isDiscreteUom(uom: string): boolean {
  return DISCRETE.has(uom.trim().toLowerCase());
}

/**
 * Round a count to a configured quantum — **opt-in only** (Aug-2026 feedback,
 * defect D-2).
 *
 * This used to be `bucketCount(qty, uom, quantum = 100)`: every non-discrete
 * count was silently rounded to the nearest 100 *stock units*. Across mixed
 * units that is destructive rather than tidy — a 4 kg count of icing sugar
 * submitted as **0**, a 250 g count as 300 — and on approval the ledger is
 * trued up to the destroyed figure. It was masked in production by defect D-1
 * (with no product map the UoM fell back to `each`, which is discrete and
 * never bucketed), so fixing D-1 without this would have started destroying
 * real counts.
 *
 * There is deliberately **no default**. A quantum is only ever meaningful when
 * it is configured per product, in that product's own stock unit — a 100 g
 * scoop is sensible for flour, meaningless for `each`, and catastrophic for
 * `kg`. Omitting the argument, or passing null/undefined/≤0, returns the
 * quantity **unchanged**, so no call site can inherit bucketing by accident.
 *
 * The per-product setting lives in `products.count_quantum` (nullable; NULL =
 * no bucketing) and reaches the count screen on the stock-take line.
 */
export function bucketCount(qty: number, uom: string, quantum?: number | null): number {
  if (quantum == null || quantum <= 0) return qty;
  if (isDiscreteUom(uom)) return qty;
  return Math.round(qty / quantum) * quantum;
}

/** Human wording for a bucketed row, so a counter can see what happened to
 *  their number rather than discovering it on the variance report. */
export function bucketNote(quantum: number | null | undefined, uom: string): string | null {
  if (quantum == null || quantum <= 0 || isDiscreteUom(uom)) return null;
  return `rounded to nearest ${quantum} ${uom}`;
}
