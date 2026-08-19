/**
 * Reading a purchase quantity back to a human (Aug-2026 feedback, C-1/C-2/C-6).
 *
 * "Icing sugar displayed an incorrect default unit quantity of 1kg."
 * "Skittles displayed an incorrect base unit, preventing the 1.6kg bags from
 *  being added."
 *
 * Goods In rendered `= 1 g · £0.00/unit` for a 25 kg sack, because it printed
 * the raw stock figure in the raw stock unit with no purchase model behind it.
 * A baker checking a delivery note reads "4 × 25 kg sack = 100 kg" — quantity,
 * pack, and the resolved amount in a unit a person uses.
 */
import { purchaseToStock } from './uom';

export interface PackShape {
  stockUom: string;
  purchaseUom: string | null;
  purchaseToStockFactor: string | number | null;
  packDescription?: string | null;
}

/** Units we can auto-scale for DISPLAY. Storage stays in the stock UoM. */
const SCALES: Record<string, Array<{ limit: number; uom: string; divisor: number }>> = {
  g: [
    { limit: 1000, uom: 'kg', divisor: 1000 },
  ],
  ml: [
    { limit: 1000, uom: 'L', divisor: 1000 },
  ],
};

/** Trim a float to at most `dp` places without leaving trailing zeroes. */
function trim(value: number, dp = 3): string {
  const rounded = Number(value.toFixed(dp));
  return String(rounded);
}

/**
 * A stock quantity in the unit a person would say out loud.
 *
 * 100000 g → "100 kg"; 250 g → "250 g"; 1600 g → "1.6 kg". **Display only** —
 * everything is still stored and sent in the stock UoM, so this can never
 * change what is booked.
 */
export function formatStockQty(qty: number, stockUom: string): string {
  const scales = SCALES[stockUom.trim().toLowerCase()];
  if (scales) {
    for (const scale of scales) {
      if (Math.abs(qty) >= scale.limit) {
        return `${trim(qty / scale.divisor)} ${scale.uom}`;
      }
    }
  }
  return `${trim(qty)} ${stockUom}`;
}

/** What one purchase unit is called: the pack description, else the UoM. */
export function packLabel(product: PackShape): string | null {
  return product.packDescription?.trim() || product.purchaseUom?.trim() || null;
}

/** The conversion factor, as a usable number. */
export function packFactor(product: PackShape): number {
  const n = Number(product.purchaseToStockFactor ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * True when the product has no purchase model at all and a booking would be
 * meaningless (defect C-1's blocked-line guard).
 *
 * Silence here is what produced the 1 g booking: a 25 kg sack and a product
 * genuinely bought by the gram are indistinguishable without this.
 */
export function needsPurchaseUnit(product: PackShape): boolean {
  const stockUom = product.stockUom.trim().toLowerCase();
  const discrete = ['each', 'ea', 'unit', 'units', 'item', 'items', 'pcs', 'piece'].includes(stockUom);
  if (discrete) return false;
  return !product.purchaseUom;
}

/**
 * "4 × 25 kg sack = 100 kg". The line as a human checks it.
 *
 * When the product has no purchase unit the phrase is deliberately NOT
 * completed — there is no honest "= N" to print, and printing "= 4 g" is
 * precisely the 12 Aug lie.
 */
export function describePackLine(qtyPurchase: number, product: PackShape): string {
  const label = packLabel(product);
  if (!label) return `${trim(qtyPurchase)} — no purchase unit set`;
  const stock = purchaseToStock(qtyPurchase, packFactor(product));
  return `${trim(qtyPurchase)} × ${label} = ${formatStockQty(stock, product.stockUom)}`;
}

/** "+1 sack" / "+1 pack" — the label on the pack-step buttons (C-6). */
export function packStepLabel(product: PackShape, sign: '+' | '−'): string {
  const label = product.purchaseUom?.trim() || 'pack';
  return `${sign}1 ${label}`;
}

/** Cost per stock unit, from the cost per purchase unit. Display only. */
export function costPerStockUnit(unitCost: number, product: PackShape): number {
  const factor = packFactor(product);
  return factor > 0 ? unitCost / factor : unitCost;
}

/**
 * Money at the precision it is actually held (defect C-4).
 *
 * `£0.00` was the tester's report, and 2dp formatting is half the reason —
 * £0.0012/g is a real price, not a rounding error. Shows 2dp for ordinary
 * amounts and up to 6 significant decimals for sub-penny ones, rather than
 * printing six places on every figure.
 */
export function formatMoney(value: number, currency = '£'): string {
  if (value === 0) return `${currency}0.00`;
  if (Math.abs(value) >= 0.01) return `${currency}${value.toFixed(2)}`;
  return `${currency}${Number(value.toFixed(6))}`;
}
