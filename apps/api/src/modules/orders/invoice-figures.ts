/**
 * The net, VAT and gross figures an invoice states, worked out from an order.
 *
 * Pure, and all in whole pence. The order's stored columns mean different
 * things depending on how it was made:
 *
 *   - Storefront orders store prices, goods and delivery INCLUDING VAT. The
 *     order's tax total is the VAT inside them, delivery's VAT included, and
 *     grand total = goods + delivery.
 *   - Admin-created orders store prices EXCLUDING VAT and add tax on top:
 *     grand total = goods + tax + delivery.
 *
 * Nothing on the order reliably says which it is (taxInclusive is left at its
 * default by the storefront), so, as the admin order page does, this reads the
 * arithmetic: whichever identity the stored totals satisfy.
 *
 * Whatever the kind, an invoice states net amounts per line, the VAT, and a
 * total that equals what the customer was charged. Adding the tax total on top
 * of VAT-inclusive prices, as invoices used to, overstated both.
 */

export interface FigureOrder {
  orderTotal: string | number | null | undefined;
  taxTotal: string | number | null | undefined;
  deliveryCharge: string | number | null | undefined;
  grandTotal: string | number | null | undefined;
}

export interface FigureLine {
  quantity: number;
  lineTotal: string | number | null | undefined;
  taxValue: string | number | null | undefined;
  taxRate: number | null | undefined;
}

export interface InvoiceLineFigures {
  quantity: number;
  taxRate: number;
  unitNetPence: number;
  netPence: number;
  vatPence: number;
  grossPence: number;
}

export interface InvoiceFigures {
  pricesIncludeTax: boolean;
  lines: InvoiceLineFigures[];
  goodsNetPence: number;
  goodsVatPence: number;
  deliveryNetPence: number;
  deliveryVatPence: number;
  totalNetPence: number;
  totalVatPence: number;
  grossPence: number;
  /** The invoice total matches the order's grand total, to the penny. */
  reconciles: boolean;
}

export function toPence(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function fromPence(pence: number): string {
  return (pence / 100).toFixed(2);
}

/** Stored figures are rounded to the penny independently, so allow 1p. */
const TOLERANCE_PENCE = 1;

/** True when goods and delivery already include the tax total. */
export function totalsIncludeTax(order: FigureOrder): boolean {
  const goods = toPence(order.orderTotal);
  const delivery = toPence(order.deliveryCharge);
  const grand = toPence(order.grandTotal);
  const tax = toPence(order.taxTotal);
  const inclusiveGap = Math.abs(grand - (goods + delivery));
  const exclusiveGap = Math.abs(grand - (goods + tax + delivery));
  if (inclusiveGap <= TOLERANCE_PENCE) return true;
  if (exclusiveGap <= TOLERANCE_PENCE) return false;
  return inclusiveGap <= exclusiveGap;
}

export function invoiceFigures(order: FigureOrder, lines: FigureLine[]): InvoiceFigures {
  const inclusive = totalsIncludeTax(order);

  const lineFigures = lines.map((l) => {
    const total = toPence(l.lineTotal);
    const vat = toPence(l.taxValue);
    const quantity = Number(l.quantity) || 0;
    const net = inclusive ? total - vat : total;
    return {
      quantity,
      taxRate: Number(l.taxRate ?? 0),
      unitNetPence: quantity > 0 ? Math.round(net / quantity) : 0,
      netPence: net,
      vatPence: vat,
      grossPence: net + vat,
    };
  });

  const goodsNet = lineFigures.reduce((s, l) => s + l.netPence, 0);
  const goodsVat = lineFigures.reduce((s, l) => s + l.vatPence, 0);

  // Any VAT the order records beyond its lines' is the delivery charge's: the
  // storefront splits it out of the VAT-inclusive delivery charge.
  const deliveryCharge = toPence(order.deliveryCharge);
  const deliveryVat = Math.max(0, toPence(order.taxTotal) - goodsVat);
  const deliveryNet = inclusive ? deliveryCharge - deliveryVat : deliveryCharge;

  const totalNet = goodsNet + deliveryNet;
  const totalVat = goodsVat + deliveryVat;
  const gross = totalNet + totalVat;

  return {
    pricesIncludeTax: inclusive,
    lines: lineFigures,
    goodsNetPence: goodsNet,
    goodsVatPence: goodsVat,
    deliveryNetPence: deliveryNet,
    deliveryVatPence: deliveryVat,
    totalNetPence: totalNet,
    totalVatPence: totalVat,
    grossPence: gross,
    reconciles: Math.abs(gross - toPence(order.grandTotal)) <= TOLERANCE_PENCE,
  };
}
