/**
 * Units-of-measure helpers (spec §A3).
 *
 * Products are bought in `purchase_uom` (e.g. a bag) and tracked in `stock_uom`
 * (e.g. grams). `purchase_to_stock_factor` is stock_uom per 1 purchase_uom
 * (1 bag = 1000 g ⇒ 1000); `purchase_pack_size` is the ordering granularity
 * (you can only buy whole cases). Recipes and reorder points operate in
 * stock_uom. Fungible counts/reorder are bucketed to a quantum (~100 g);
 * discrete items (`each`) are whole units only.
 */

/** Stock units that are inherently discrete (whole units only). */
const DISCRETE_UOMS = new Set(['each', 'ea', 'unit', 'units', 'item', 'items', 'pcs', 'piece']);

export function isDiscreteStockUom(uom: string): boolean {
  return DISCRETE_UOMS.has(uom.trim().toLowerCase());
}

/** Convert a quantity in purchase_uom to stock_uom. */
export function purchaseToStock(purchaseQty: number, factor: number): number {
  return purchaseQty * factor;
}

/** Convert a quantity in stock_uom back to purchase_uom. */
export function stockToPurchase(stockQty: number, factor: number): number {
  if (factor === 0) throw new RangeError('purchase_to_stock_factor must be non-zero');
  return stockQty / factor;
}

/**
 * Round an order quantity (in purchase_uom) UP to a whole multiple of the
 * supplier's pack size — you can't order half a case.
 */
export function roundUpToPackMultiple(purchaseQty: number, packSize: number): number {
  if (packSize <= 0) return purchaseQty;
  return Math.ceil(purchaseQty / packSize) * packSize;
}

/** Round a quantity to the NEAREST quantum (default 100, e.g. ~100 g buckets). */
export function roundToQuantum(qty: number, quantum = 100): number {
  if (quantum <= 0) return qty;
  return Math.round(qty / quantum) * quantum;
}

/** Round a quantity UP to a quantum — used for reorder so we never under-buy. */
export function ceilToQuantum(qty: number, quantum = 100): number {
  if (quantum <= 0) return qty;
  return Math.ceil(qty / quantum) * quantum;
}

export class FractionalDiscreteQtyError extends RangeError {
  constructor(uom: string, qty: number) {
    super(`Discrete stock unit "${uom}" cannot hold a fractional quantity (${qty})`);
    this.name = 'FractionalDiscreteQtyError';
  }
}

/**
 * Validate a stock-uom quantity: a discrete unit (`each`) rejects fractional
 * amounts. Fungible units (g, ml, …) accept any value. Throws on violation.
 */
export function assertValidStockQty(uom: string, qty: number): void {
  if (isDiscreteStockUom(uom) && !Number.isInteger(qty)) {
    throw new FractionalDiscreteQtyError(uom, qty);
  }
}

export function isValidStockQty(uom: string, qty: number): boolean {
  return !isDiscreteStockUom(uom) || Number.isInteger(qty);
}
