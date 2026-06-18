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

/** Round a fungible count to the nearest quantum (default ~100 g). Discrete
 *  units are returned unchanged (whole units already). */
export function bucketCount(qty: number, uom: string, quantum = 100): number {
  if (isDiscreteUom(uom) || quantum <= 0) return qty;
  return Math.round(qty / quantum) * quantum;
}
